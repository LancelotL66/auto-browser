// Site Adapter: Zhihu (知乎)
// Actions (params.action):
//   hot            — today's hot list (default)
//   search         — search_v3 candidates ranked by 赞同+2×评论 (params: query, count)
//   comments       — top comments via legacy API (params: url, limit)
//   like           — like an answer/article (params: url)
//   comment        — post a comment (params: url, text)
//   likeAndComment — like + comment in one call (params: url, text)
//   probe          — interruption checkpoint: tabs/dialogs/overlays/pending
//
// Selectors/APIs hardened on 2026-08-11 real-site testing:
//   - like button is `.VoteButton` (no `--up` modifier, hashed class) — NOT `.VoteButton--up`
//   - comment editor lives under `.Comments-container .InputLike [contenteditable]`,
//     NOT `.CommentEditor`; needs real-keyboard-equivalent input:
//     execCommand('insertText') (Draft.js ignores key events)
//   - the comment toggle has no aria-label; it's a `.ContentItem-action` with text 评论
//   - comment_v5 returns empty `data` to automation sessions; use legacy
//     `api/v4/{answers|articles}/{id}/comments` instead
//   - comment panels lazy-render; open the panel with a retry loop
import { executeStep } from '../../core/plan.mjs';

export const description = 'Zhihu (知乎): hot list, search, like/comment answers & articles, comment extraction';
export const params = ['action', 'url', 'text', 'query', 'count', 'limit'];
export const examples = [
  { params: { action: 'hot' }, desc: 'Today\'s hot topics' },
  { params: { action: 'search', query: '明朝史', count: 10 }, desc: 'Search and rank candidates by popularity' },
  { params: { action: 'like', url: 'https://www.zhihu.com/question/.../answer/...' }, desc: 'Like an answer/article' },
  { params: { action: 'comment', url: '...', text: '1' }, desc: 'Post a comment (Draft.js-safe)' },
  { params: { action: 'likeAndComment', url: '...', text: '1' }, desc: 'Like + comment in one call' },
  { params: { action: 'comments', url: '...', limit: 10 }, desc: 'Fetch top comments (legacy API)' }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Run plan steps against the page; aggregate ok/result.
async function runSteps(page, steps) {
  const ctx = { elements: [] };
  const out = [];
  for (const step of steps) {
    const r = await executeStep(page, step, ctx);
    out.push({ op: step.op, ok: r.ok, ms: r.ms, error: r.error || null, result: r.result || null, newTab: r.newTab || false });
    if (!r.ok) return { ok: false, steps: out, failed: step.op, error: r.error };
  }
  return { ok: true, steps: out };
}

async function navigate(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(300);
}

// API-calling actions need a zhihu origin so the page session's cookies apply
// (search_v3 requires auth; legacy comments work anonymously but be consistent).
async function ensureZhihuOrigin(page) {
  const url = page.url() || '';
  if (!/^(https?:\/\/)?(www\.|zhuanlan\.)?zhihu\.com/i.test(url)) {
    await navigate(page, 'https://www.zhihu.com/hot');
  }
}

// Legacy comment API (comment_v5 returns empty data to automation sessions).
async function fetchComments(page, url, limit = 10) {
  return page.evaluate(async ({ url: u, lim }) => {
    const m = u.match(/\/answer\/(\d+)/);
    const p = u.match(/\/p\/(\d+)/);
    const id = m ? m[1] : (p ? p[1] : null);
    if (!id) return { comments: [], total: 0, error: 'not an answer/article URL' };
    const type = m ? 'answers' : 'articles';
    const r = await fetch(`https://www.zhihu.com/api/v4/${type}/${id}/comments?limit=${Math.min(lim, 20)}&offset=0`, {
      headers: { 'Accept': 'application/json' }, credentials: 'include'
    });
    const j = await r.json();
    const comments = (j.data || []).map(c => (c.content || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    return { comments, total: j.paging?.totals ?? comments.length, count: comments.length };
  }, { url, lim: limit });
}

const LIKE_SELECTOR = '.VoteButton:not(.VoteButton--down)';

export default async function execute(page, params = {}) {
  const action = params.action || 'hot';

  switch (action) {

    case 'hot': {
      await ensureZhihuOrigin(page);
      const result = await page.evaluate(async () => {
        const resp = await fetch('https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=20', {
          headers: { 'Accept': 'application/json' }, credentials: 'include'
        });
        const data = await resp.json();
        return (data.data || []).map(item => ({
          title: item.target.title,
          excerpt: item.target.excerpt || item.target.title_area?.text || '',
          hot: item.detail_text || '',
          url: `https://www.zhihu.com/question/${item.target.id}`,
          answerCount: item.target.answer_count,
          followerCount: item.target.follower_count
        }));
      });
      return { action, items: result };
    }

    case 'search': {
      await ensureZhihuOrigin(page);
      const query = params.query || '知乎';
      const count = params.count || 10;
      const result = await page.evaluate(async ({ q, lim }) => {
        const r = await fetch(
          `https://www.zhihu.com/api/v4/search_v3?t=general&q=${encodeURIComponent(q)}&correction=1&offset=0&limit=${Math.min(lim * 2, 30)}`,
          { headers: { 'Accept': 'application/json' }, credentials: 'include' }
        );
        const data = await r.json();
        const out = [];
        const strip = s => String(s || '').replace(/<[^>]+>/g, '').slice(0, 80);
        for (const item of (data.data || [])) {
          if (item.type !== 'search_result') continue;
          const obj = item.object || {};
          let title = '', url = '', votes = 0, comments = 0;
          const type = obj.type;
          if (obj.type === 'answer' && obj.question) {
            title = obj.question.title || obj.excerpt || '';
            url = `https://www.zhihu.com/question/${obj.question.id}/answer/${obj.id}`;
            votes = obj.voteup_count || 0;
            comments = obj.comment_count || 0;
          } else if (obj.type === 'article') {
            title = obj.title || obj.excerpt || '';
            url = `https://zhuanlan.zhihu.com/p/${obj.id}`;
            votes = obj.voteup_count || 0;
            comments = obj.comment_count || 0;
          } else if (obj.type === 'question') {
            title = obj.title || '';
            url = `https://www.zhihu.com/question/${obj.id}`;
            votes = 0;
            comments = obj.comment_count || 0;
          }
          if (!url || !title) continue;
          out.push({ type, title: strip(title), url, votes, comments, score: votes + comments * 2 });
        }
        out.sort((a, b) => b.score - a.score);
        return { query: q, fetched: (data.data || []).length, candidates: out.slice(0, lim) };
      }, { q: query, lim: count });
      return { action, ...result };
    }

    case 'comments': {
      if (!params.url) throw new Error('comments: provide url');
      await ensureZhihuOrigin(page);
      return { action, url: params.url, ...(await fetchComments(page, params.url, params.limit || 10)) };
    }

    case 'like': {
      if (!params.url) throw new Error('like: provide url');
      await navigate(page, params.url);
      const out = await runSteps(page, [
        { op: 'wait', kind: 'selector', target: '.RichText, article, .QuestionAnswer-content', timeout: 15000 },
        { op: 'wait', kind: 'stable', timeout: 5000 },
        { op: 'eval', code: `return (() => { const b = [...document.querySelectorAll('.VoteButton')].find(x => !x.className.includes('VoteButton--down') && (x.getAttribute('aria-label') || '').includes('赞同')); if (!b) return { found: false }; return { found: true, active: b.className.includes('is-active') || (b.getAttribute('aria-label') || '').includes('已赞同') }; })();` },
        { op: 'click', target: LIKE_SELECTOR },
        { op: 'eval', code: `return (() => { const b = [...document.querySelectorAll('.VoteButton')].find(x => !x.className.includes('VoteButton--down') && (x.getAttribute('aria-label') || '').includes('赞同')); return b ? { liked: b.className.includes('is-active') || (b.getAttribute('aria-label') || '').includes('已赞同') } : { liked: false }; })();` }
      ]);
      const wasLiked = out.steps?.[2]?.result?.active === true;
      const liked = out.steps?.[4]?.result?.liked === true;
      return { action, url: params.url, ok: out.ok, alreadyLiked: wasLiked, liked: liked || wasLiked, steps: out.steps };
    }

    case 'comment':
    case 'likeAndComment': {
      if (!params.url) throw new Error(`${action}: provide url`);
      const text = String(params.text ?? '').trim();
      if (!text) throw new Error(`${action}: provide text`);
      await navigate(page, params.url);
      const steps = [
        { op: 'wait', kind: 'selector', target: '.RichText, article, .QuestionAnswer-content', timeout: 15000 },
        { op: 'wait', kind: 'stable', timeout: 5000 }
      ];
      if (action === 'likeAndComment') {
        steps.push(
          { op: 'eval', code: `return (() => { const b = [...document.querySelectorAll('.VoteButton')].find(x => !x.className.includes('VoteButton--down') && (x.getAttribute('aria-label') || '').includes('赞同')); return b ? { active: b.className.includes('is-active') || (b.getAttribute('aria-label') || '').includes('已赞同') } : { active: false }; })();` },
          { op: 'click', target: LIKE_SELECTOR }
        );
      }
      steps.push(
        // Open the comment panel: retry-loop over the page's 评论 buttons
        // (question and answer sections both have one) until an editor is
        // visible; dataset marks buttons already tried.
        { op: 'eval', code: `return (async () => {
          for (let i = 0; i < 10; i++) {
            const ed = document.querySelector('.Comments-container [contenteditable]');
            if (ed && ed.offsetParent !== null) return { panelOpen: true };
            const btn = [...document.querySelectorAll('.ContentItem-action, [class*=CommentButton], button')].find(x =>
              x.offsetParent !== null && (x.innerText || '').includes('评论') && !(x.innerText || '').includes('收起') && !x.dataset.__abClicked);
            if (btn) { btn.dataset.__abClicked = '1'; btn.click(); }
            await new Promise(r => setTimeout(r, 500));
          }
          return { panelOpen: false, tried: true };
        })();` },
        { op: 'sleep', ms: 1200 },
        // Draft.js ignores key events; execCommand insertText is the reliable path.
        { op: 'contenteditable', target: ".Comments-container [contenteditable='true']", value: text },
        { op: 'eval', code: `return (() => { const b = [...document.querySelectorAll('.Comments-container button')].find(x => (x.innerText || '').trim() === '发布'); if (b) { b.click(); return { clicked: true }; } return { clicked: false }; })();` }
      );
      const out = await runSteps(page, steps);
      const publish = out.steps?.find(s => s.op === 'eval' && s.result?.clicked !== undefined);
      return {
        action, url: params.url, text,
        ok: out.ok,
        typed: out.steps?.find(s => s.op === 'contenteditable')?.result?.value || null,
        published: publish?.result?.clicked === true,
        panelOpen: out.steps?.find(s => s.op === 'eval')?.result?.panelOpen,
        steps: out.steps
      };
    }

    case 'probe': {
      const r = await executeStep(page, { op: 'probe' }, {});
      return { action, ok: r.ok, ...(r.result || {}) };
    }

    default:
      throw new Error(`zhihu: unknown action "${action}" (hot|search|comments|like|comment|likeAndComment|probe)`);
  }
}
