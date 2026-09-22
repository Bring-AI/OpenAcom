'use strict';
// Executed inside the verified ZCode renderer. Keep this function self-contained
// because desktop-delivery serializes it over CDP.
function selectDesktopSession(id, title, workspace, lease, expiry) {
  const visible = element => Boolean(element.getClientRects().length) && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).opacity !== '0';
  const existing = window.__openacomDesktopLease;
  if (existing && existing.expiry > Date.now() && existing.id !== lease) return 'busy';
  const inputs = [...document.querySelectorAll('[data-testid="v4-composer-input"]')].filter(visible);
  if (inputs.some(input => input.textContent !== '' || input.querySelector('img,video,audio,[data-lexical-decorator]'))) return 'draft';
  const dialogs = [...document.querySelectorAll('[role="dialog"][data-state="open"]')].filter(visible);
  if (dialogs.length) return 'dialog-open';
  const panes = [...document.querySelectorAll('[data-testid^="v4-session-pane-"][data-session-id]')].filter(pane => visible(pane) && pane.getAttribute('data-session-id') === id);
  if (panes.length > 1) return 'ambiguous-id';
  const acquire = () => { window.__openacomDesktopLease = {id:lease, expiry}; };
  if (panes.length === 1) { acquire(); return 'active'; }
  const sidebar = document.querySelector('[data-testid="sidebar"]');
  if (!sidebar) return 'unsupported';
  const rows = [...sidebar.querySelectorAll('[data-testid^="task-item-"]')].filter(visible);
  const matches = rows.filter(row => row.getAttribute('data-testid') === 'task-item-' + id);
  if (matches.length > 1) return 'ambiguous-id';
  if (matches.length === 1) {
    const label = matches[0].querySelector('[data-task-title-copy="original"]');
    if (!label || label.textContent.trim() !== title) return 'title-mismatch';
    acquire(); matches[0].click(); return 'selected';
  }
  // The desktop limits a workspace's visible list. Its mounted TaskList exposes
  // the same one-argument navigation callback used by a row click. Only use a
  // uniquely identified local workspace callback; never infer a remote owner.
  const normalize = value => { const p=String(value || '').replace(/\\/g,'/').replace(/\/+$/,''); return /^[A-Za-z]:\//.test(p)||p.startsWith('//')?p.toLowerCase():p; };
  if (!workspace) return 'not-listed';
  const roots = [...sidebar.querySelectorAll('[data-testid^="workspace-item-"]')].filter(row => normalize(row.getAttribute('data-testid').slice('workspace-item-'.length)) === normalize(workspace));
  if (roots.length !== 1) return 'workspace-unavailable';
  if (roots[0].getAttribute('aria-expanded') === 'false') { acquire(); roots[0].click(); return 'expanded'; }
  const container = document.getElementById(roots[0].getAttribute('aria-controls'));
  if (!container) return 'loading-workspace';
  const candidates = new Set();
  for (const row of container.querySelectorAll('[data-testid^="task-item-"]')) {
    const key = Object.keys(row).find(key => key.startsWith('__reactFiber$'));
    let fiber = key && row[key];
    for (let depth=0;depth<45 && fiber;depth++,fiber=fiber.return) {
      const p = fiber.memoizedProps;
      if (p && normalize(p.workspacePath) === normalize(workspace) && !p.remoteSessionId && !p.workspaceIdentity && !p.remoteTarget && !p.readOnlyReason && Array.isArray(p.tasks) && typeof p.hasMore === 'boolean' && typeof p.onSelectTask === 'function' && p.onSelectTask.length === 1) candidates.add(p.onSelectTask);
    }
  }
  if (candidates.size !== 1) return candidates.size ? 'ambiguous-navigator' : 'not-listed';
  acquire();
  try { [...candidates][0](id); return 'navigated'; }
  catch { if(window.__openacomDesktopLease?.id===lease) delete window.__openacomDesktopLease;return 'navigation-failed'; }
}
module.exports = {selectDesktopSession};
