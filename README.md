# CodeGame WATT Auto-Claim and Sell Bot

Automated bot for claiming WATT tokens from CodeGame.fun and optionally selling them via Jupiter aggregator on Solana.

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure environment**:
   ```bash
   cp .env.local.example .env.local
   ```

3. **Edit `.env.local`** and set your wallet private key and preferences:
   - `WALLET_PRIVATE_KEY`: Your Solana wallet private key (base58 or JSON array format)
   - Adjust other settings as needed (see Configuration section)

## Usage

### Test Run (Dry Run)
```bash
node scripts/autoClaimAndSell.js
# or
npm run claim
```

### Live Execution
```bash
DRY_RUN=false node scripts/autoClaimAndSell.js
# or
npm run claim:live
```

## Configuration

All configuration is done via `.env.local`:

| Variable | Description | Default |
|----------|-------------|---------|
| `WALLET_PRIVATE_KEY` | Your Solana wallet private key (required) | - |
| `NEXT_PUBLIC_RPC_ENDPOINT` | Solana RPC endpoint | `https://api.mainnet-beta.solana.com` |
| `MIN_CLAIMABLE_WATT` | Minimum WATT to claim before triggering | `1` |
| `AUTO_SELL_ENABLED` | Enable auto-sell after claiming | `true` |
| `AUTO_SELL_TOKEN` | Token to sell to (SOL/USDC/USDT) | `USDC` |
| `AUTO_SELL_PERCENTAGE` | Percentage of claimed tokens to sell (0-100) | `50` |
| `MIN_SELL_PRICE_USD` | Minimum WATT price in USD to sell (0 = no check) | `0.0` |
| `SLIPPAGE_BPS` | Jupiter slippage in basis points (100 = 1%) | `100` |
| `PRIORITY_FEE_LAMPORTS` | Transaction priority fee | `10000` |
| `DRY_RUN` | If true, simulates actions without executing | `false` |

## Scheduling with Cron

To run automatically every hour:

```bash
crontab -e
```

Add:
```bash
0 * * * * cd /path/to/codeclaimandsellbot && DRY_RUN=false /usr/local/bin/node scripts/autoClaimAndSell.js >> logs/cron.log 2>&1
```

## Logs

All execution logs are saved to `logs/autoClaimAndSell.log`.

## How It Works

1. Connects to Solana RPC
2. Finds your user state account by querying on-chain program accounts
3. Attempts to claim WATT rewards from CodeGame program
4. If claim succeeds and `AUTO_SELL_ENABLED=true`:
   - Calculates amount to sell based on `AUTO_SELL_PERCENTAGE`
   - Fetches Jupiter quote for swap
   - Executes market order swap to configured token
5. Logs all operations

## Token Info

- **WATT Token**: `WattxY7ZKjPGcPn4mDK442SA7YQC4xwnjsSHPAJ7WXQ`
- **CodeGame Program**: `CDE3ggMwLy6c8Eu3Ez2mcfrt8W8WmdZXrjR2wzinWbaz`
- **Decimals**: 6

## Notes

- **Important**: You must first create an account on [CodeGame.fun](https://www.codegame.fun/) and initialize it before using this bot
- Always test with `DRY_RUN=true` first
- Ensure your wallet has SOL for transaction fees
- Jupiter API is used for price quotes and swaps
- Only market orders are supported (no limit orders)
- The script automatically finds your user state account by querying on-chain data

## Support

If this bot helps you, consider supporting development:

**Solana**: `2aMpFajeoewqNoeeUjN9jFWREXzV3sh4sXqp17vx9cn9`

Thank you! 🙏
