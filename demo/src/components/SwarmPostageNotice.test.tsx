import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SwarmPostageNotice } from './SwarmPostageNotice';

/** Bee responses the notice reads before it can offer anything. */
const stubNode = (bzzBalance: string, nativeTokenBalance = '1000000000') =>
  vi.stubGlobal('fetch', async (url: string) => {
    if (String(url).includes('/chainstate')) {
      return new Response(
        JSON.stringify({
          currentPrice: '71865',
          block: 1,
          minimumValidityBlocks: 17280,
        }),
      );
    }
    if (String(url).includes('/wallet')) {
      return new Response(
        JSON.stringify({
          bzzBalance,
          nativeTokenBalance,
          walletAddress: '0x2f55cd47d91c30c46bba107215e10d96d41ec1df',
          chainID: 100,
        }),
      );
    }
    throw new Error(`unexpected request: ${url}`);
  });

afterEach(() => vi.unstubAllGlobals());

const openPanel = async () => {
  fireEvent.click(screen.getByRole('button', { name: /get a postage batch/i }));
  await waitFor(() => screen.getByText(/Keep it for/));
};

describe('SwarmPostageNotice', () => {
  it('says where the text went, not just that saving is off', () => {
    render(<SwarmPostageNotice beeUrl="http://bee.invalid" onBatchReady={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toMatch(
      /kept in this browser only/i,
    );
  });

  it('can be dismissed and stays out of the way', () => {
    render(<SwarmPostageNotice beeUrl="http://bee.invalid" onBatchReady={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('quotes a price from the node before spending anything', async () => {
    stubNode('100000000000000000'); // 10 xBZZ — comfortably funded
    render(<SwarmPostageNotice beeUrl="http://bee.invalid" onBatchReady={vi.fn()} />);
    await openPanel();
    // 30 days at depth 17 and the stubbed price ≈ 0.4884 xBZZ — shown as
    // the cost and repeated on the button, so the click is unambiguous.
    expect(screen.getAllByText(/0\.488\d? xBZZ/).length).toBeGreaterThan(0);
    expect(
      screen.getByRole('button', { name: /buy for 0\.488\d? xBZZ/i }),
    ).toBeTruthy();
  });

  it('explains how to fund the node instead of offering an impossible purchase', async () => {
    stubNode('1000'); // effectively empty
    render(<SwarmPostageNotice beeUrl="http://bee.invalid" onBatchReady={vi.fn()} />);
    await openPanel();
    expect(screen.queryByRole('button', { name: /^buy for/i })).toBeNull();
    expect(screen.getByText(/cannot cover this yet/i)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: /how to fund a bee node/i }),
    ).toBeTruthy();
  });

  it('mentions gas when the node has no xDAI', async () => {
    stubNode('100000000000000000', '0');
    render(<SwarmPostageNotice beeUrl="http://bee.invalid" onBatchReady={vi.fn()} />);
    await openPanel();
    expect(screen.getByText(/no xDAI for gas/i)).toBeTruthy();
  });
});
