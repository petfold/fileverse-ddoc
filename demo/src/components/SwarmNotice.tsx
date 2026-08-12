import { useState } from 'react';
import {
  SwarmCondition,
  SwarmRemedyKind,
} from '../../../package/utils/swarm-diagnostics';
import { SwarmPostagePanel } from './SwarmPostagePanel';

/**
 * One bar, above the editor, for every way Swarm can be unavailable —
 * offline, node down, no postage, batch expiring, batch full, or an
 * operation that failed. The wording and the offered remedies come from
 * `diagnoseSwarm`, so this component stays a renderer: new conditions
 * appear here without changing it.
 *
 * Placed above the document rather than over it. Editing continues in every
 * one of these states — edits persist locally and go out once Swarm is
 * writable again — so blocking the page would remove a working capability
 * and still not explain anything.
 */

export interface SwarmNoticeProps {
  condition: SwarmCondition;
  beeUrl: string;
  /** Batch in use, needed to top up or dilute it. */
  batchId?: string;
  onRetry: () => void;
  /** A batch became usable: adopt it and resume saving. */
  onBatchReady: (_batchId: string) => void;
}

export const SwarmNotice = ({
  condition,
  beeUrl,
  batchId,
  onRetry,
  onBatchReady,
}: SwarmNoticeProps) => {
  const [dismissed, setDismissed] = useState(false);
  const [panel, setPanel] = useState<SwarmRemedyKind | null>(null);

  if (dismissed) return null;

  const isBlocked = condition.severity === 'blocked';

  return (
    <div
      className="border-b color-border-default text-[13px]"
      style={{ backgroundColor: 'hsl(var(--color-bg-secondary))' }}
    >
      <div
        className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2"
        role={isBlocked ? 'alert' : 'status'}
      >
        <span>
          <strong className="font-medium">{condition.title}.</strong>{' '}
          {condition.detail}
        </span>
        <span className="flex items-center gap-2 ml-auto">
          {condition.remedies.map((remedy) =>
            remedy.kind === 'learn-more' ? (
              <a
                key={remedy.kind + remedy.label}
                href={remedy.href}
                target="_blank"
                rel="noreferrer"
                className="h-7 px-2 flex items-center"
              >
                {remedy.label}
              </a>
            ) : (
              <button
                key={remedy.kind + remedy.label}
                type="button"
                onClick={() =>
                  remedy.kind === 'retry'
                    ? onRetry()
                    : setPanel(panel === remedy.kind ? null : remedy.kind)
                }
                className="h-7 px-3 rounded border color-border-default font-medium whitespace-nowrap"
              >
                {remedy.label}
              </button>
            ),
          )}
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

      {panel && (
        <SwarmPostagePanel
          mode={panel}
          beeUrl={beeUrl}
          batchId={batchId}
          onClose={() => setPanel(null)}
          onBatchReady={(id) => {
            setPanel(null);
            onBatchReady(id);
          }}
        />
      )}
    </div>
  );
};
