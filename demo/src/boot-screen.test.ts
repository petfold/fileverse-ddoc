import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The boot screen in index.html, which is all a visitor sees until the app
 * bundle arrives.
 *
 * Its failure path is the interesting part: served from Swarm, a large
 * script can fail to arrive — a node that has just started is still finding
 * peers, and we measured a 2.4 MB asset coming back truncated in that
 * window. Nothing else on the page can report that, so without this
 * watchdog the screen spins until the tab is closed, which is exactly what
 * was observed in Freedom.
 */

const html = readFileSync(
  resolve(__dirname, '../index.html'),
  'utf8',
);

/** Mount the boot markup and run the inline watchdog against it. */
const bootPage = () => {
  const body = html.split('<body>')[1].split('</body>')[0];
  document.body.innerHTML = body.replace(
    /<script[\s\S]*?<\/script>/g,
    '',
  );
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  // eslint-disable-next-line no-new-func
  new Function(script)();
};

const boot = () => document.getElementById('boot');
const failure = () => document.getElementById('boot-failed');

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('boot screen', () => {
  it('counts how long the visitor has been waiting', () => {
    bootPage();
    vi.advanceTimersByTime(3000);
    expect(document.getElementById('boot-elapsed')!.textContent).toMatch(/\ds/);
  });

  it('explains the wait once it stops looking instant', () => {
    bootPage();
    expect(document.getElementById('boot-slow')!.hidden).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(document.getElementById('boot-slow')!.hidden).toBe(false);
  });

  it('gives up waiting and says so, rather than spinning forever', () => {
    bootPage();
    expect(failure()!.hidden).toBe(true);
    vi.advanceTimersByTime(46_000);
    expect(failure()!.hidden).toBe(false);
    expect(failure()!.textContent).toMatch(/did not finish downloading/i);
    expect(document.getElementById('boot-reload')).toBeTruthy();
  });

  it('reports a script that fails to load immediately, without waiting', () => {
    bootPage();
    const script = document.createElement('script');
    document.body.appendChild(script);
    script.dispatchEvent(new Event('error', { bubbles: false }));
    expect(failure()!.hidden).toBe(false);
  });

  it('stays quiet once the app has mounted', () => {
    bootPage();
    // React replaces the container's contents on first render.
    document.getElementById('root')!.innerHTML = '<div>the app</div>';
    vi.advanceTimersByTime(120_000);
    expect(boot()).toBeNull();
  });

  it('offers a reload that actually reloads', () => {
    bootPage();
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    vi.advanceTimersByTime(46_000);
    document.getElementById('boot-reload')!.dispatchEvent(
      new Event('click', { bubbles: true }),
    );
    expect(reload).toHaveBeenCalledOnce();
  });
});
