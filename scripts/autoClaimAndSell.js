/**
 * Auto-Claim and Auto-Sell WATT Rewards Script
 *
 * Automatically claims WATT rewards from CodeGame.fun,
 * then optionally sells them via Jupiter aggregator.
 *
 * Features:
 * - Automatic claiming when threshold is met
 * - Configurable auto-sell percentage
 * - Configurable slippage and priority fees
 * - Comprehensive logging
 *
 * Usage:
 *   node scripts/autoClaimAndSell.js              # Dry run mode (default)
 *   DRY_RUN=false node scripts/autoClaimAndSell.js  # Live mode
 */

const { Connection, PublicKey, Transaction, TransactionInstruction, Keypair, VersionedTransaction } = require('@solana/web3.js');
const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58').default || require('bs58');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: '.env.local' });

// ============================================================================
// CONFIGURATION
// ============================================================================

const PROGRAM_ID = new PublicKey('CDE3ggMwLy6c8Eu3Ez2mcfrt8W8WmdZXrjR2wzinWbaz');
const WATT_MINT = new PublicKey('WattxY7ZKjPGcPn4mDK442SA7YQC4xwnjsSHPAJ7WXQ');
const GLOBAL_CONFIG_PDA = new PublicKey('Bxe5mdxrNB9xFd4Ciyn7VFWM2enSLqHz9qz89eA35Ws1');
const VAULT_ACCOUNT = new PublicKey('GRckfqRR61ULadHAwwXXAU2DqXNSNBnRumCBUNPLK865');

// Claim instruction discriminator (from transaction analysis)
// Base58 decoded: mHL85s1kFy = 0x0490844774179750
const CLAIM_INSTRUCTION_DISCRIMINATOR = bs58.decode('mHL85s1kFy');

// Claim configuration
const MIN_CLAIMABLE_WATT = parseFloat(process.env.MIN_CLAIMABLE_WATT || '1');

// Auto-sell configuration
const AUTO_SELL_ENABLED = process.env.AUTO_SELL_ENABLED === 'true';
const AUTO_SELL_TOKEN = process.env.AUTO_SELL_TOKEN || 'SOL';
const AUTO_SELL_PERCENTAGE = parseFloat(process.env.AUTO_SELL_PERCENTAGE || '100'); // 0-100
const MIN_SELL_PRICE_USD = parseFloat(process.env.MIN_SELL_PRICE_USD || '0.0');
const SLIPPAGE_BPS = parseInt(process.env.SLIPPAGE_BPS || '100');
const PRIORITY_FEE_LAMPORTS = parseInt(process.env.PRIORITY_FEE_LAMPORTS || '0');

// Token addresses
const TOKEN_ADDRESSES = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  WATT: 'WattxY7ZKjPGcPn4mDK442SA7YQC4xwnjsSHPAJ7WXQ',
};

// Jupiter API (v1 endpoints)
const JUPITER_API = 'https://lite-api.jup.ag/swap/v1';

// System
const DRY_RUN = process.env.DRY_RUN !== 'false';
const RPC_URL = process.env.NEXT_PUBLIC_RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'autoClaimAndSell.log');

// ============================================================================
// LOGGING
// ============================================================================

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message}`;
  console.log(logMessage);

  ensureLogDir();
  fs.appendFileSync(LOG_FILE, logMessage + '\n');
}

// ============================================================================
// WALLET LOADING
// ============================================================================

function loadWallet() {
  const privateKeyEnv = process.env.WALLET_PRIVATE_KEY;

  if (!privateKeyEnv) {
    throw new Error('WALLET_PRIVATE_KEY not found in .env.local');
  }

  try {
    if (privateKeyEnv.trim().startsWith('[')) {
      const secretKey = Uint8Array.from(JSON.parse(privateKeyEnv));
      return Keypair.fromSecretKey(secretKey);
    }

    const secretKey = bs58.decode(privateKeyEnv);
    return Keypair.fromSecretKey(secretKey);
  } catch (error) {
    throw new Error(`Failed to load wallet: ${error.message}`);
  }
}

// ============================================================================
// USER STATE ACCOUNT DISCOVERY
// ============================================================================

async function findUserStateAccount(connection, wallet) {
  // CodeGame doesn't use standard PDA derivation
  // We need to find the user's state account by querying program accounts
  log('Searching for user state account...', 'INFO');

  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [
      {
        memcmp: {
          offset: 8, // Skip 8-byte discriminator
          bytes: wallet.toBase58(),
        },
      },
    ],
  });

  if (accounts.length === 0) {
    throw new Error('User state account not found. Have you initialized your account on CodeGame?');
  }

  if (accounts.length > 1) {
    log(`Warning: Found ${accounts.length} state accounts, using first one`, 'WARN');
  }

  return accounts[0].pubkey;
}

// ============================================================================
// TOKEN BALANCE
// ============================================================================

async function getWattBalance(connection, wallet) {
  try {
    const wattAccount = await getAssociatedTokenAddress(
      WATT_MINT,
      wallet,
      false,
      TOKEN_PROGRAM_ID
    );

    const accountInfo = await connection.getTokenAccountBalance(wattAccount);
    return accountInfo.value.uiAmount || 0;
  } catch (error) {
    // Token account might not exist yet
    return 0;
  }
}

// ============================================================================
// CLAIM LOGIC
// ============================================================================

async function buildClaimTransaction(connection, wallet, userStateAccount) {
  const userWattAccount = await getAssociatedTokenAddress(
    WATT_MINT,
    wallet.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );

  // Account structure based on transaction analysis
  // Order from actual claim transaction:
  // 0: User wallet (signer)
  // 1: User state account
  // 2: Global config
  // 3: Vault account
  // 4: User WATT token account
  // 5: WATT mint
  // 6: Token program
  const keys = [
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },          // User wallet
    { pubkey: userStateAccount, isSigner: false, isWritable: true },         // User state account
    { pubkey: GLOBAL_CONFIG_PDA, isSigner: false, isWritable: true },        // Global config
    { pubkey: VAULT_ACCOUNT, isSigner: false, isWritable: true },            // Vault (token source)
    { pubkey: userWattAccount, isSigner: false, isWritable: true },          // User WATT account (destination)
    { pubkey: WATT_MINT, isSigner: false, isWritable: false },               // WATT mint
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },        // Token program
  ];

  const instruction = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys,
    data: CLAIM_INSTRUCTION_DISCRIMINATOR
  });

  const transaction = new Transaction().add(instruction);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = wallet.publicKey;

  return transaction;
}

async function sendAndConfirmTransaction(connection, transaction, wallet) {
  transaction.sign(wallet);

  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed'
  });

  log(`Claim transaction sent: ${signature}`, 'INFO');

  const confirmation = await connection.confirmTransaction(signature, 'confirmed');

  if (confirmation.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  return signature;
}

async function getActualClaimedAmount(connection, signature, walletPubkey) {
  try {
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0
    });

    if (!tx || !tx.meta) {
      return null;
    }

    // Check token balance changes
    if (tx.meta.postTokenBalances && tx.meta.preTokenBalances) {
      for (let i = 0; i < tx.meta.postTokenBalances.length; i++) {
        const post = tx.meta.postTokenBalances[i];
        const pre = tx.meta.preTokenBalances.find(p => p.accountIndex === post.accountIndex);

        if (pre && post.owner === walletPubkey.toBase58() &&
            post.mint === WATT_MINT.toBase58()) {
          const change = post.uiTokenAmount.uiAmount - pre.uiTokenAmount.uiAmount;
          if (change > 0) {
            return change;
          }
        }
      }
    }

    return null;
  } catch (error) {
    log(`Warning: Could not fetch actual claimed amount: ${error.message}`, 'WARN');
    return null;
  }
}

// ============================================================================
// JUPITER INTEGRATION
// ============================================================================

async function getWattPriceUSD() {
  try {
    // Try direct WATT/USDC route first
    const wattAmount = 1_000_000; // 1 WATT (6 decimals)

    try {
      const quote = await getJupiterQuote(
        TOKEN_ADDRESSES.WATT,
        TOKEN_ADDRESSES.USDC,
        wattAmount,
        50 // Low slippage for price check
      );

      const usdcAmount = parseFloat(quote.outAmount) / 1_000_000; // USDC has 6 decimals
      return usdcAmount;
    } catch (quoteError) {
      // If direct route fails, try WATT -> SOL -> USDC
      log(`Direct WATT/USDC route not available, trying via SOL...`, 'INFO');

      const wattSolQuote = await getJupiterQuote(
        TOKEN_ADDRESSES.WATT,
        TOKEN_ADDRESSES.SOL,
        wattAmount,
        50
      );

      const solAmount = parseFloat(wattSolQuote.outAmount) / 1_000_000_000; // SOL has 9 decimals

      // Get SOL/USDC price
      const solUsdcQuote = await getJupiterQuote(
        TOKEN_ADDRESSES.SOL,
        TOKEN_ADDRESSES.USDC,
        1_000_000_000, // 1 SOL
        50
      );

      const solPriceUSD = parseFloat(solUsdcQuote.outAmount) / 1_000_000;
      const wattPriceUSD = solAmount * solPriceUSD;

      log(`WATT price via SOL: $${wattPriceUSD.toFixed(6)} (SOL: $${solPriceUSD.toFixed(2)})`, 'INFO');
      return wattPriceUSD;
    }
  } catch (error) {
    log(`Warning: Could not fetch WATT price: ${error.message}`, 'WARN');

    // If MIN_SELL_PRICE_USD is 0, we can proceed without price check
    if (MIN_SELL_PRICE_USD === 0) {
      log(`MIN_SELL_PRICE_USD is 0, will attempt swap without price verification`, 'WARN');
      return 0; // Return 0 to allow swap to proceed
    }

    return null;
  }
}

async function getJupiterQuote(inputMint, outputMint, amount, slippageBps) {
  const url = new URL(`${JUPITER_API}/quote`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', amount.toString());
  url.searchParams.set('slippageBps', slippageBps.toString());
  url.searchParams.set('onlyDirectRoutes', 'false');
  url.searchParams.set('asLegacyTransaction', 'false');

  const response = await fetch(url.toString());

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Jupiter quote failed (${response.status}): ${errorText}`);
  }

  return await response.json();
}

async function executeSwap(connection, wallet, quote) {
  // Build swap request payload
  const swapPayload = {
    quoteResponse: quote,
    userPublicKey: wallet.publicKey.toString(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
  };

  // Add priority fee if specified (Jupiter v1 API format)
  if (PRIORITY_FEE_LAMPORTS > 0) {
    swapPayload.prioritizationFeeLamports = {
      priorityLevelWithMaxLamports: {
        maxLamports: PRIORITY_FEE_LAMPORTS,
        priorityLevel: 'high'
      }
    };
  }

  const swapResponse = await fetch(`${JUPITER_API}/swap`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(swapPayload),
  });

  if (!swapResponse.ok) {
    const errorText = await swapResponse.text();
    throw new Error(`Jupiter swap failed (${swapResponse.status}): ${errorText}`);
  }

  const { swapTransaction } = await swapResponse.json();

  // Deserialize and sign transaction
  const transactionBuf = Buffer.from(swapTransaction, 'base64');
  const transaction = VersionedTransaction.deserialize(transactionBuf);
  transaction.sign([wallet]);

  // Send transaction
  const signature = await connection.sendTransaction(transaction, {
    skipPreflight: false,
    maxRetries: 3,
  });

  log(`Swap transaction sent: ${signature}`, 'INFO');

  // Confirm transaction
  const confirmation = await connection.confirmTransaction(signature, 'confirmed');

  if (confirmation.value.err) {
    throw new Error(`Swap transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  return signature;
}

async function autoSell(connection, wallet, wattAmount) {
  log('========================================', 'INFO');
  log('AUTO-SELL: Starting sell process', 'INFO');
  log('========================================', 'INFO');

  // Validate percentage
  if (AUTO_SELL_PERCENTAGE < 0 || AUTO_SELL_PERCENTAGE > 100) {
    throw new Error(`Invalid AUTO_SELL_PERCENTAGE: ${AUTO_SELL_PERCENTAGE}. Must be between 0 and 100`);
  }

  // Calculate amount to sell based on percentage
  const totalClaimed = wattAmount;
  const amountToSell = (wattAmount * AUTO_SELL_PERCENTAGE) / 100;
  const amountToKeep = wattAmount - amountToSell;

  log(`Total claimed: ${totalClaimed.toFixed(6)} WATT`, 'INFO');
  log(`Sell percentage: ${AUTO_SELL_PERCENTAGE}%`, 'INFO');
  log(`Amount to sell: ${amountToSell.toFixed(6)} WATT`, 'INFO');
  log(`Amount to keep: ${amountToKeep.toFixed(6)} WATT`, 'INFO');

  // If selling 0%, skip
  if (AUTO_SELL_PERCENTAGE === 0 || amountToSell < 0.000001) {
    log('AUTO_SELL_PERCENTAGE is 0% or amount too small. Keeping all WATT.', 'INFO');
    return null;
  }

  // Get output token mint
  const outputMint = TOKEN_ADDRESSES[AUTO_SELL_TOKEN];
  if (!outputMint) {
    throw new Error(`Invalid AUTO_SELL_TOKEN: ${AUTO_SELL_TOKEN}. Must be SOL, USDC, or USDT`);
  }

  log(`Target: Swap to ${AUTO_SELL_TOKEN}`, 'INFO');

  // Get current WATT price
  const currentPriceUSD = await getWattPriceUSD();

  if (currentPriceUSD === null) {
    log('Could not fetch WATT price.', 'ERROR');
    log('This usually means:', 'ERROR');
    log('  1. WATT token has no liquidity on Jupiter DEXs', 'ERROR');
    log('  2. Network/API issues', 'ERROR');
    log('  3. Token not yet listed on major DEXs', 'ERROR');
    log('', 'ERROR');
    log('To proceed anyway, set MIN_SELL_PRICE_USD=0 in .env.local', 'ERROR');
    log('Aborting auto-sell for safety.', 'ERROR');
    throw new Error('Could not fetch WATT price. Aborting auto-sell.');
  }

  if (currentPriceUSD > 0) {
    log(`Current WATT price: $${currentPriceUSD.toFixed(6)} USD`, 'INFO');
  } else {
    log('WATT price check skipped (MIN_SELL_PRICE_USD=0)', 'WARN');
  }

  // Check minimum price threshold
  if (MIN_SELL_PRICE_USD > 0 && currentPriceUSD > 0 && currentPriceUSD < MIN_SELL_PRICE_USD) {
    log(`Price $${currentPriceUSD.toFixed(6)} is below minimum $${MIN_SELL_PRICE_USD.toFixed(6)}. Skipping sell.`, 'WARN');
    return null;
  }

  const wattLamports = Math.floor(amountToSell * 1_000_000);

  log('Strategy: Market order (immediate execution)', 'INFO');

  if (DRY_RUN) {
    log('✅ DRY RUN: Would execute market swap now', 'INFO');
    return null;
  }

  // Get quote
  const quote = await getJupiterQuote(
    TOKEN_ADDRESSES.WATT,
    outputMint,
    wattLamports,
    SLIPPAGE_BPS
  );

  const outputAmount = parseFloat(quote.outAmount) / 1_000_000;
  log(`Expected output: ${outputAmount.toFixed(6)} ${AUTO_SELL_TOKEN}`, 'INFO');

  // Execute swap
  const signature = await executeSwap(connection, wallet, quote);

  log(`✅ SWAP SUCCESS: ${amountToSell.toFixed(6)} WATT → ${outputAmount.toFixed(6)} ${AUTO_SELL_TOKEN}`, 'INFO');
  log(`   Kept in wallet: ${amountToKeep.toFixed(6)} WATT`, 'INFO');
  log(`Transaction: https://solscan.io/tx/${signature}`, 'INFO');

  return { type: 'swap', signature, inputAmount: amountToSell, outputAmount, outputToken: AUTO_SELL_TOKEN, keptAmount: amountToKeep };
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  log('========================================', 'INFO');
  log('Auto-Claim and Auto-Sell Script Started', 'INFO');
  log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`, 'INFO');
  log(`Auto-Sell: ${AUTO_SELL_ENABLED ? 'ENABLED' : 'DISABLED'}`, 'INFO');
  log('========================================', 'INFO');

  try {
    // Load wallet
    log('Loading wallet...', 'INFO');
    const wallet = loadWallet();
    log(`Wallet loaded: ${wallet.publicKey.toBase58()}`, 'INFO');

    // Connect to Solana
    log(`Connecting to RPC: ${RPC_URL.split('?')[0]}...`, 'INFO');
    const connection = new Connection(RPC_URL, 'confirmed');

    // Find User State Account
    const userStateAccount = await findUserStateAccount(connection, wallet.publicKey);
    log(`User state account: ${userStateAccount.toBase58()}`, 'INFO');

    // Get current WATT balance before claiming
    const balanceBefore = await getWattBalance(connection, wallet.publicKey);
    log(`Current WATT balance: ${balanceBefore.toFixed(6)} WATT`, 'INFO');

    // ========================================
    // CLAIM REWARDS
    // ========================================

    if (DRY_RUN) {
      log('✅ DRY RUN: Would claim rewards now', 'INFO');

      // In dry run, estimate we'd get MIN_CLAIMABLE_WATT for testing auto-sell
      if (AUTO_SELL_ENABLED) {
        await autoSell(connection, wallet, MIN_CLAIMABLE_WATT);
      }

      log('To execute for real, run: DRY_RUN=false node scripts/autoClaimAndSell.js', 'INFO');
      return;
    }

    // Build and send claim transaction
    log('Building claim transaction...', 'INFO');
    const transaction = await buildClaimTransaction(connection, wallet, userStateAccount);

    log('Sending claim transaction...', 'INFO');
    const signature = await sendAndConfirmTransaction(connection, transaction, wallet);

    // Get actual claimed amount
    log('Fetching actual claimed amount...', 'INFO');
    const actualClaimed = await getActualClaimedAmount(connection, signature, wallet.publicKey);

    // Also check balance difference as backup
    const balanceAfter = await getWattBalance(connection, wallet.publicKey);
    const balanceDiff = balanceAfter - balanceBefore;

    const claimedAmount = actualClaimed || balanceDiff;

    if (actualClaimed !== null) {
      log(`✅ CLAIM SUCCESS: ${actualClaimed.toFixed(6)} WATT`, 'INFO');
    } else if (balanceDiff > 0) {
      log(`✅ CLAIM SUCCESS: ${balanceDiff.toFixed(6)} WATT`, 'INFO');
    } else {
      log(`✅ CLAIM SUCCESS (amount detection failed, check transaction)`, 'INFO');
    }
    log(`Transaction: https://solscan.io/tx/${signature}`, 'INFO');

    // Check if claimed amount meets minimum
    if (claimedAmount < MIN_CLAIMABLE_WATT) {
      log(`Claimed amount ${claimedAmount.toFixed(6)} is below minimum ${MIN_CLAIMABLE_WATT}. Skipping auto-sell.`, 'WARN');
      return;
    }

    // ========================================
    // AUTO-SELL (if enabled)
    // ========================================

    if (AUTO_SELL_ENABLED && claimedAmount > 0) {
      log('', 'INFO');
      await autoSell(connection, wallet, claimedAmount);
    }

  } catch (error) {
    log(`❌ ERROR: ${error.message}`, 'ERROR');
    log(error.stack, 'ERROR');
    process.exit(1);
  }

  log('========================================', 'INFO');
  log('Script Completed Successfully', 'INFO');
  log('========================================', 'INFO');
}

// Run the script
main().catch(error => {
  log(`❌ FATAL ERROR: ${error.message}`, 'ERROR');
  process.exit(1);
});
