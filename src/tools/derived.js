import { z } from 'zod';
import { jsonResult } from './_format.js';
import { getOhlcv } from '../core/data.js';
import { summarise } from '../core/derived-indicators.js';

export function registerDerivedTools(server) {
  server.tool(
    'data_get_derived_indicators',
    'Compute Stochastic, ATR, Fair Value Gaps and a volume profile from the chart OHLCV bars. These occupy NO indicator slot, so use this when the chart is already at its indicator limit (TradingView Basic allows 2) or when the indicator is simply not on the chart. Returns compact values, not full series. Flags stale data when the newest bar is over 2h old.',
    {
      bars: z.coerce.number().optional().describe('Bars to analyse (default 300, max 500). More bars = better volume profile, slower.'),
      include: z.string().optional().describe('Comma-separated subset: stochastic,atr,fvg,volume_profile. Default all. Narrow this to save context.'),
      stoch_period_k: z.coerce.number().optional().describe('Stochastic %K length (default 14)'),
      stoch_smooth_k: z.coerce.number().optional().describe('Stochastic %K smoothing (default 1, TradingView default)'),
      stoch_period_d: z.coerce.number().optional().describe('Stochastic %D smoothing (default 3)'),
      atr_period: z.coerce.number().optional().describe('ATR length (default 14)'),
      vp_bins: z.coerce.number().optional().describe('Volume profile price bins (default 24)'),
      max_gaps: z.coerce.number().optional().describe('Max unfilled FVGs to return, nearest price first (default 5)'),
    },
    async (args = {}) => {
      try {
        const include = args.include
          ? new Set(args.include.split(',').map(s => s.trim()).filter(Boolean))
          : undefined;

        const { bars } = await getOhlcv({ count: args.bars || 300 });
        if (!bars || bars.length < 30) {
          throw new Error(
            `Not enough bars (${bars?.length ?? 0}). Check that TradingView is running and the chart has loaded.`
          );
        }

        return jsonResult({ success: true, ...summarise(bars, { include, options: args }) });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
