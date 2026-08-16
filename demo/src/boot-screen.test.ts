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

/**
 * Mount the boot markup and run the inline watchdog against it. jsdom
 * shares one window across a file, so the listeners each run registers are
 * recorded and removed afterwards — otherwise a previous test's watchdog
 * reacts to the next test's events.
 */
const registered: Array<[string, EventListenerOrEventListenerObject, unknown]> =
  [];
const bootPage = () => {
  const body = html.split('<body>')[1].split('</body>')[0];
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, '');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const add = window.addEventListener.bind(window);
  window.addEventListener = ((type, handler, opts) => {
    registered.push([type, handler, opts]);
    add(type, handler, opts as never);
  }) as typeof window.addEventListener;
  try {
    // eslint-disable-next-line no-new-func
    new Function(script)();
  } finally {
    window.addEventListener = add;
  }
};

const stopWatchdogs = () => {
  for (const [type, handler, opts] of registered) {
    window.removeEventListener(type, handler, opts as never);
  }
  registered.length = 0;
};

const boot = () => document.getElementById('boot');
const failure = () => document.getElementById('boot-failed');

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
});
afterEach(() => {
  // Removing #boot first makes any live interval clear itself on next tick.
  document.body.innerHTML = '';
  stopWatchdogs();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
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

  it('retries once by itself, because the cause is usually transient', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    bootPage();
    vi.advanceTimersByTime(46_000);

    expect(document.getElementById('boot-retrying')!.hidden).toBe(false);
    expect(failure()!.hidden).toBe(true);
    vi.advanceTimersByTime(6_000);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('asks the visitor only after its own retry failed', () => {
    sessionStorage.setItem('ddoc-boot-retried', '1');
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    bootPage();
    vi.advanceTimersByTime(46_000);

    expect(failure()!.hidden).toBe(false);
    expect(failure()!.textContent).toMatch(/could not be downloaded/i);
    // Crucially, it must not reload again: that would be a loop.
    vi.advanceTimersByTime(30_000);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reports a script that fails to load immediately, without waiting', () => {
    vi.stubGlobal('location', { reload: vi.fn() });
    bootPage();
    const script = document.createElement('script');
    document.body.appendChild(script);
    script.dispatchEvent(new Event('error', { bubbles: false }));
    // First failure retries; the visitor is not asked to do anything yet.
    expect(document.getElementById('boot-retrying')!.hidden).toBe(false);
  });

  it('stays quiet once the app has mounted', () => {
    bootPage();
    // React replaces the container's contents on first render.
    document.getElementById('root')!.innerHTML = '<div>the app</div>';
    vi.advanceTimersByTime(120_000);
    expect(boot()).toBeNull();
  });

  it('offers a reload that actually reloads', () => {
    sessionStorage.setItem('ddoc-boot-retried', '1');
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
