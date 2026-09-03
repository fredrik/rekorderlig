/* What you have opened. Every place a title is a link — both decks, the
   reveal, the feed and the Votes list — marks the story read through here,
   and the two lists paint the mark. A leaf like reveal.js: it imports the
   DOM helpers and the formatter, never a view. */

import { api, el } from './dom.js';
import { ago } from './format.js';

/** The comments thread on HN, which every story has. */
export const threadHref = (story) => `https://news.ycombinator.com/item?id=${story.id}`;

/** Where a title link goes: the story's URL, or the thread when it has none. */
export const storyHref = (story) => story.url ?? threadHref(story);

/**
 * Which door a title link opens. An Ask HN has no URL, so its title *is* the
 * thread — the mark says what was opened, not which anchor was hit.
 */
export const titleKind = (story) => (story.url ? 'link' : 'thread');

/** Opened at all — either door. What the feed's default view hides. */
export const isRead = (story) => story.link_at != null || story.thread_at != null;

/**
 * Record that a door was opened. The story object is stamped at once, so a
 * row can repaint without a reload, and the server's answer — which keeps the
 * *first* opening — replaces the guess when it lands. Nothing waits on it:
 * the click already opened the tab, and a failed mark is one more click
 * away, so an error here is swallowed rather than shouted into a page the
 * reader has just left.
 */
export async function markRead(story, kind, paint) {
  const key = kind === 'thread' ? 'thread_at' : 'link_at';
  if (story[key] == null) story[key] = Math.floor(Date.now() / 1000);
  paint?.();
  try {
    const { read } = await api('/api/read', { method: 'POST', body: { id: story.id, kind } });
    if (read) {
      story.link_at = read.linkAt ?? null;
      story.thread_at = read.threadAt ?? null;
      paint?.();
    }
  } catch {
    // See above: the tab is open, the mark can wait for the next click.
  }
}

/**
 * Make an anchor mark its story read when followed. `click` covers a plain
 * click and a modified one; `auxclick` is the middle button, which opens a
 * tab without ever firing `click`. A right-click's "open in new tab" is
 * invisible to a page and stays unmarked.
 */
export function bindRead(anchor, story, kind, paint) {
  const opened = () => markRead(story, kind, paint);
  anchor.addEventListener('click', opened);
  anchor.addEventListener('auxclick', (e) => { if (e.button === 1) opened(); });
  return anchor;
}

/**
 * What the mark says. Both doors are told apart because the issue that asked
 * for this wanted them told apart: having read the argument is not having
 * read the article. The time is the later door's — the most recent thing
 * that happened to the row, the way "Voted 3h ago" is.
 */
export function readLine(story) {
  const { link_at: link, thread_at: thread } = story;
  const what = link != null && thread != null ? 'Read, and the thread'
    : thread != null ? 'Thread read'
      : 'Read';
  return `${what} ${ago(Math.max(link ?? 0, thread ?? 0))}`;
}

/**
 * The read state of one list row: the `read` class on the row, so the title
 * dims like a visited link; the mark in the sub-line; and its undo. Returns
 * the sub-line nodes and the repaint, which is also what `bindRead` calls
 * when a door on the row is opened.
 *
 * The undo is here because the feed hides what was opened: without a way
 * back, a mis-click would lose a story for good. It forgets both doors at
 * once, since the feed hides on either.
 */
export function readRow(li, story, { onError } = {}) {
  const mark = el('span', { className: 'read-mark' });
  const undo = el('button', { type: 'button', title: 'Forget that you opened this' }, 'Unread');
  const paint = () => {
    const read = isRead(story);
    li.classList.toggle('read', read);
    mark.hidden = !read;
    undo.hidden = !read;
    mark.textContent = read ? readLine(story) : '';
  };
  undo.addEventListener('click', async () => {
    const was = { link_at: story.link_at, thread_at: story.thread_at };
    story.link_at = null;
    story.thread_at = null;
    paint();
    try {
      await api('/api/unread', { method: 'POST', body: { id: story.id } });
    } catch (err) {
      Object.assign(story, was);
      paint();
      onError?.(err);
    }
  });
  paint();
  return { nodes: [mark, undo], paint };
}
