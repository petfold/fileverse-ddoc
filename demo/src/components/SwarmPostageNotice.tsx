import { useEffect, useState } from 'react';
import {
  BatchEstimate,
  MIN_BATCH_DEPTH,
  PLUR_PER_BZZ,
  WalletBalance,
  buyStamp,
  estimateBatch,
  getChainState,
  getStamp,
  getWalletBalance,
} from '../../../package/utils/swarm-stamps';

/**
 * Shown when the Bee node has no postage batch: the document still opens
 * and stays editable, but nothing reaches Swarm.
 *
 * Editing is deliberately not blocked. Edits persist locally, the node may
 * gain a batch at any moment, and a read-only editor would be a worse
 * answer than a clear warning — but "read-only" alone doesn't say where
 * the text went or how to fix it, so this says both, and offers the fix.
 *
 * Buying spends real xBZZ from the node's own wallet, so the exact cost is
 * shown first and nothing happens without an explicit click.
 */

export interface SwarmPostageNoticeProps {
  beeUrl: string;
  /** Called with the new batch id once it is usable for uploads. */
  onBatchReady: (_batchId: string) => void;
}

type Phase =
  | { kind: 'collapsed' }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'buying' }
  | { kind: 'waiting'; batchId: string }
  | { kind: 'done'; batchId: string }
  | { kind: 'error'; message: string };

const DURATIONS = [
  { days: 30, label: '30 days' },
  { days: 90, label: '3 months' },
  { days: 365, label: '1 year' },
];

const formatBzz = (plur: number) => (plur / PLUR_PER_BZZ).toFixed(4);
const formatSize = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;

export const SwarmPostageNotice = ({
  beeUrl,
  onBatchReady,
}: SwarmPostageNoticeProps) => {
  const [phase, setPhase] = useState<Phase>({ kind: 'collapsed' });
  const [dismissed, setDismissed] = useState(false);
  const [price, setPrice] = useState<number | null>(null);
  const [wallet, setWallet] = useState<WalletBalance | null>(null);
  const [days, setDays] = useState(30);
  const [depth, setDepth] = useState(MIN_BATCH_DEPTH);

  const open = async () => {
    setPhase({ kind: 'loading' });
    try {
      const [chain, balance] = await Promise.all([
        getChainState({ beeUrl }),
        getWalletBalance({ beeUrl }),
      ]);
      setPrice(chain.currentPrice);
      setWallet(balance);
      setPhase({ kind: 'ready' });
    } catch (error) {
      setPhase({ kind: 'error', message: (error as Error).message });
    }
  };

  const estimate: BatchEstimate | null =
    price === null ? null : estimateBatch({ depth, days, price });
  const affordable =
    estimate && wallet ? wallet.bzzBalance >= estimate.costPlur : false;
  const hasGas = wallet ? wallet.nativeTokenBalance > 0 : false;

  const buy = async () => {
    if (!estimate) return;
    setPhase({ kind: 'buying' });
    try {
      const batchId = await buyStamp(
        { beeUrl },
        {
          amount: String(estimate.amount),
          depth: estimate.depth,
          label: 'ddoc-demo',
        },
      );
      setPhase({ kind: 'waiting', batchId });
    } catch (error) {
      setPhase({ kind: 'error', message: (error as Error).message });
    }
  };

  // A fresh batch is not usable until it has settled on-chain.
  useEffect(() => {
    if (phase.kind !== 'waiting') return;
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const stamp = await getStamp({ beeUrl }, phase.batchId);
        if (!cancelled && stamp.usable) {
          clearInterval(id);
          setPhase({ kind: 'done', batchId: phase.batchId });
          onBatchReady(phase.batchId);
        }
      } catch {
        // Not visible yet — keep polling.
      }
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [phase, beeUrl, onBatchReady]);

  if (dismissed || phase.kind === 'done') return null;

  const panelStyle = {
    backgroundColor: 'hsl(var(--color-bg-secondary))',
  } as const;

  if (phase.kind === 'collapsed') {
    return (
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[13px] border-b color-border-default"
        style={panelStyle}
        role="status"
      >
        <span>
          <strong className="font-medium">Not saving to Swarm.</strong> Your
          edits are kept in this browser only — this Bee node has no postage
          batch, which is what pays for uploads.
        </span>
        <span className="flex gap-2 ml-auto">
          <button
            type="button"
            onClick={open}
            className="h-7 px-3 rounded border color-border-default font-medium"
          >
            Get a postage batch
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="h-7 px-2 rounded color-text-secondary"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </span>
      </div>
    );
  }

  return (
    <div
      className="px-4 py-3 text-[13px] border-b color-border-default"
      style={panelStyle}
    >
      <div className="max-w-2xl flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[14px] font-medium">Get a postage batch</h2>
          <button
            type="button"
            onClick={() => setPhase({ kind: 'collapsed' })}
            className="ml-auto color-text-secondary"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <p className="color-text-secondary">
          Storing data on Swarm is paid up front with a postage batch: a
          prepaid amount of storage that expires unless topped up. Reading is
          always free.
        </p>

        {phase.kind === 'loading' && <p>Reading pricing from your node…</p>}

        {phase.kind === 'error' && (
          <p role="alert">Could not complete this: {phase.message}</p>
        )}

        {phase.kind === 'waiting' && (
          <p>
            Batch bought — waiting for it to settle on-chain. This takes a few
            blocks; saving starts by itself.
          </p>
        )}

        {(phase.kind === 'ready' || phase.kind === 'buying') && estimate && (
          <>
            <div className="flex flex-wrap gap-4">
              <label className="flex flex-col gap-1">
                <span className="color-text-secondary text-[12px]">
                  Keep it for
                </span>
                <select
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                  className="h-8 px-2 rounded border color-border-default color-bg-default"
                >
                  {DURATIONS.map((d) => (
                    <option key={d.days} value={d.days}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="color-text-secondary text-[12px]">
                  Room for
                </span>
                <select
                  value={depth}
                  onChange={(e) => setDepth(Number(e.target.value))}
                  className="h-8 px-2 rounded border color-border-default color-bg-default"
                >
                  {[MIN_BATCH_DEPTH, 18, 19, 20].map((d) => (
                    <option key={d} value={d}>
                      {formatSize(
                        estimateBatch({ depth: d, days, price: price! })
                          .usableCapacityBytes,
                      )}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex flex-col gap-1">
                <span className="color-text-secondary text-[12px]">Cost</span>
                <span className="h-8 flex items-center font-medium tabular-nums">
                  {formatBzz(estimate.costPlur)} xBZZ
                </span>
              </div>
            </div>

            {wallet && (
              <p className="color-text-secondary">
                Your node holds {formatBzz(wallet.bzzBalance)} xBZZ
                {hasGas ? '' : ' and no xDAI for gas'}.
              </p>
            )}

            {affordable && hasGas ? (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={buy}
                  disabled={phase.kind === 'buying'}
                  className="h-8 px-3 rounded border color-border-default font-medium"
                >
                  {phase.kind === 'buying'
                    ? 'Buying…'
                    : `Buy for ${formatBzz(estimate.costPlur)} xBZZ`}
                </button>
                <span className="color-text-secondary">
                  Spends real funds from your node's wallet.
                </span>
              </div>
            ) : (
              <p>
                Your node cannot cover this yet. Fund its wallet (
                <code className="text-[12px]">
                  {wallet?.walletAddress ?? 'address unavailable'}
                </code>
                ) with xBZZ{hasGas ? '' : ' and a little xDAI for gas'} on
                Gnosis Chain, or pick a smaller or shorter batch.{' '}
                <a
                  href="https://docs.ethswarm.org/docs/bee/installation/fund-your-node"
                  target="_blank"
                  rel="noreferrer"
                >
                  How to fund a Bee node
                </a>
                .
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
};
