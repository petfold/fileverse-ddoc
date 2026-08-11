import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SwarmRestoreProgress } from './SwarmRestoreProgress';

const noop = () => {};

describe('SwarmRestoreProgress', () => {
  it('names every stage so a long wait is legible', () => {
    render(
      <SwarmRestoreProgress
        nodeState={{ kind: 'connecting' }}
        progress={null}
        onSkip={noop}
        onRetry={noop}
      />,
    );
    expect(screen.getByText(/Reaching the Bee node/)).toBeTruthy();
    expect(screen.getByText(/Finding the latest version/)).toBeTruthy();
    expect(screen.getByText(/Downloading the document/)).toBeTruthy();
  });

  it('shows transfer percentage once the download reports sizes', () => {
    render(
      <SwarmRestoreProgress
        nodeState={{ kind: 'ready', batchId: 'ab12' }}
        progress={{
          stage: 'download',
          status: 'progress',
          loaded: 512,
          total: 1024,
        }}
        onSkip={noop}
        onRetry={noop}
      />,
    );
    expect(screen.getByText(/50%/)).toBeTruthy();
  });

  it('always offers a way out of a stalled restore', () => {
    const onSkip = vi.fn();
    render(
      <SwarmRestoreProgress
        nodeState={{ kind: 'read-only', reason: 'no batch' }}
        progress={{ stage: 'feed-lookup', status: 'start' }}
        onSkip={onSkip}
        onRetry={noop}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: /without restoring/i }),
    );
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it('surfaces the failure reason and a retry when the restore errors', () => {
    const onRetry = vi.fn();
    render(
      <SwarmRestoreProgress
        nodeState={{ kind: 'unreachable', reason: 'connection refused' }}
        progress={null}
        error="Swarm request timed out after 60s"
        onSkip={noop}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('timed out');
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
