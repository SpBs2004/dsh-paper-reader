import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fileAddressFor } from './address.js';
import { renderMath, renderRich } from './math.js';
import { PdfReader, sectionForPage } from './pdfview.js';

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatDate(ms) {
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 把笔记 markdown 拆成条目（标题 / 引文 / 正文）。 */
function parseNotes(markdown) {
  const chunks = String(markdown ?? '').split(/^## /m);
  const head = chunks.shift() ?? '';
  const entries = [];
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const headline = (lines.shift() ?? '').trim();
    const quoteLines = [];
    const textLines = [];
    let inQuote = true;
    for (const line of lines) {
      if (line.startsWith('> ')) {
        if (inQuote) quoteLines.push(line.slice(2));
        else textLines.push(line);
        continue;
      }
      if (line.trim() === '') {
        if (quoteLines.length > 0) inQuote = false;
        else if (textLines.length > 0) textLines.push('');
        continue;
      }
      inQuote = false;
      textLines.push(line);
    }
    const text = textLines.join('\n').trim();
    if (headline === '' && text === '' && quoteLines.length === 0) continue;
    entries.push({ headline, quote: quoteLines.join('\n'), text });
  }
  return { title: head.replace(/^#\s*/, '').trim(), entries };
}

function buildAskPrompt({ doc, selection, instruction }) {
  const location = [];
  const section = doc?.outline?.find((item) => item.id === selection?.block?.sectionId);
  if (section) location.push(`§${section.title}`);
  if (Number.isFinite(selection?.block?.line)) location.push(`L${selection.block.line}`);
  if (Number.isFinite(selection?.block?.page)) location.push(`p.${selection.block.page}`);
  const quoted = String(selection?.text ?? '')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return [
    `Paper: ${doc?.title ?? ''} (${doc?.path ?? ''})`,
    location.length > 0 ? `Location: ${location.join(' · ')}` : '',
    'Selected passage:',
    quoted,
    '',
    instruction,
  ]
    .filter((line) => line !== undefined && line !== null)
    .join('\n');
}

export function PaperReaderPanel({ api, ctx, t, tracker }) {
  const [boot, setBoot] = useState({ loading: true, roots: [], defaultRoot: null, error: null });
  const [papers, setPapers] = useState([]);
  const [listLoading, setListLoading] = useState(false);
  const [root, setRoot] = useState(null);
  const [rootDialog, setRootDialog] = useState(false);
  const [rootDraft, setRootDraft] = useState('');
  const [rootError, setRootError] = useState('');
  const [rootBusy, setRootBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [doc, setDoc] = useState(null);
  const [docState, setDocState] = useState('idle');
  const [docError, setDocError] = useState('');
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [notes, setNotes] = useState({ path: '', exists: false, markdown: '' });
  const [editor, setEditor] = useState(null);
  const [selection, setSelection] = useState(null);
  const [selPos, setSelPos] = useState(null);
  const [popover, setPopover] = useState(null);
  const [bilingual, setBilingual] = useState(false);
  const [translations, setTranslations] = useState({});
  const [translating, setTranslating] = useState(null);
  const [pdfView, setPdfView] = useState('pages');
  const [toast, setToast] = useState(null);
  const [targets, setTargets] = useState([]);
  const [lastLine, setLastLine] = useState(null);

  const articleRef = useRef(null);
  const pdfNavRef = useRef(null);
  const toastTimer = useRef(null);
  const translateToken = useRef(0);

  const showToast = useCallback((text, kind) => {
    setToast({ text, kind: kind ?? 'info' });
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3600);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
  }, []);

  // 首次加载：根目录 + 论文列表 + 会话候选
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const state = await api.state();
        if (!alive) return;
        setBoot({ loading: false, roots: state.roots ?? [], defaultRoot: state.defaultRoot ?? null, error: null });
        setRoot(state.defaultRoot ?? null);
        const list = await api.list();
        if (!alive) return;
        setPapers(list.papers ?? []);
      } catch (error) {
        if (!alive) return;
        setBoot({ loading: false, roots: [], defaultRoot: null, error: error.message });
      }
      try {
        const value = await api.targets();
        if (alive) setTargets(value.sessions ?? []);
      } catch {
        /* 没有会话不影响阅读 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [api]);

  const reloadList = useCallback(
    async (nextRoot) => {
      setListLoading(true);
      try {
        const list = await api.list(nextRoot ?? root ?? undefined);
        setPapers(list.papers ?? []);
      } catch (error) {
        showToast(error.message, 'error');
      } finally {
        setListLoading(false);
      }
    },
    [api, root, showToast],
  );

  const applyRoots = useCallback(
    (state, preferred) => {
      const roots = state.roots ?? [];
      setBoot({ loading: false, roots, defaultRoot: state.defaultRoot ?? null, error: null });
      const keep = preferred !== undefined && preferred !== null ? preferred : root;
      const next = roots.some((entry) => entry.path === keep) ? keep : state.defaultRoot ?? roots[0]?.path ?? null;
      setRoot(next);
      return next;
    },
    [root],
  );

  const openRootDialog = useCallback(() => {
    setRootError('');
    setRootDraft('');
    setRootDialog(true);
  }, []);

  const closeRootDialog = useCallback(() => {
    if (rootBusy) return;
    setRootDialog(false);
    setRootError('');
    setRootDraft('');
  }, [rootBusy]);

  const submitRoot = useCallback(async () => {
    const value = rootDraft.trim();
    if (value === '') {
      setRootError(t('library.roots.emptyPath'));
      return;
    }
    setRootBusy(true);
    setRootError('');
    try {
      const state = await api.addRoot(value);
      const next = applyRoots(state, value);
      setRootDialog(false);
      setRootDraft('');
      await reloadList(next ?? undefined);
      showToast(t('library.roots.added', { path: value }));
    } catch (error) {
      setRootError(t('library.roots.addFailed', { message: error.message }));
    } finally {
      setRootBusy(false);
    }
  }, [api, applyRoots, reloadList, rootDraft, showToast, t]);

  const removeRoot = useCallback(
    async (target) => {
      if (rootBusy) return;
      setRootBusy(true);
      setRootError('');
      try {
        const state = await api.removeRoot(target);
        const next = applyRoots(state);
        await reloadList(next ?? undefined);
        showToast(t('library.roots.removed', { path: target }));
      } catch (error) {
        setRootError(t('library.roots.removeFailed', { message: error.message }));
      } finally {
        setRootBusy(false);
      }
    },
    [api, applyRoots, reloadList, rootBusy, showToast, t],
  );

  const browseRoot = useCallback(async () => {
    setRootError('');
    try {
      const workspace = ctx.get('uiWorkspace');
      if (workspace !== undefined && workspace !== null && typeof workspace.pickDirectory === 'function') {
        const picked = await workspace.pickDirectory();
        if (typeof picked === 'string' && picked.trim() !== '') {
          setRootDraft(picked);
          return;
        }
        if (picked === null) return;
      }
    } catch {
      /* 宿主没有 uiWorkspace 时退回自有选择器 */
    }
    try {
      const value = await api.pickDirectory();
      if (value !== null && value !== undefined && typeof value.path === 'string' && value.path !== '') {
        setRootDraft(value.path);
      } else if (value?.supported === false) {
        setRootError(t('library.roots.pickUnavailable'));
      } else if (typeof value?.message === 'string' && value.message !== '') {
        setRootError(value.message);
      }
    } catch {
      setRootError(t('library.roots.pickUnavailable'));
    }
  }, [api, ctx, t]);

  const selectPaper = useCallback(
    async (paper) => {
      setSelectedId(paper.id);
      setDocState('loading');
      setDocError('');
      setDoc(null);
      setTranslations({});
      setBilingual(false);
      setEditor(null);
      setLastLine(null);
      setPdfView('pages');
      setSelection(null);
      setSelPos(null);
      try {
        const view = await api.view(paper.id);
        setDoc(view);
        setDocState('ready');
      } catch (error) {
        setDocState('error');
        setDocError(error.message);
      }
      try {
        const noteValue = await api.notesRead(paper.id);
        setNotes({ path: noteValue.path ?? '', exists: noteValue.exists === true, markdown: noteValue.markdown ?? '' });
      } catch {
        setNotes({ path: '', exists: false, markdown: '' });
      }
    },
    [api],
  );

  const resolveSessionId = useCallback(async () => {
    const remembered = tracker?.current?.();
    if (typeof remembered === 'string' && remembered !== '') return remembered;
    if (targets.length > 0) return targets[0].id;
    try {
      const value = await api.targets();
      const list = value.sessions ?? [];
      setTargets(list);
      return list[0]?.id ?? null;
    } catch {
      return null;
    }
  }, [api, targets, tracker]);

  const ask = useCallback(
    async (instructionKey) => {
      if (selection === null) {
        showToast(t('ask.noSelection'), 'error');
        return;
      }
      const instruction = t(`ask.${instructionKey}`);
      const sessionId = await resolveSessionId();
      if (sessionId === null) {
        showToast(t('reader.askUnavailable'), 'error');
        return;
      }
      try {
        await api.ask(sessionId, buildAskPrompt({ doc, selection, instruction }));
        setSelection(null);
        setSelPos(null);
        try {
          ctx.get('layout')?.selectPanel?.(null);
        } catch {
          /* 切面板失败不影响提问 */
        }
      } catch (error) {
        showToast(t('ask.failed', { message: error.message }), 'error');
      }
    },
    [api, ctx, doc, resolveSessionId, selection, showToast, t],
  );

  const translateSelection = useCallback(async () => {
    if (selection === null) return;
    const anchor = selPos ?? { x: window.innerWidth / 2, y: 160 };
    setPopover({ title: t('actions.translate'), text: '', loading: true, x: anchor.x, y: anchor.y + 40 });
    try {
      const value = await api.translate(selection.text);
      setPopover({ title: t('actions.translate'), text: value.text ?? '', loading: false, x: anchor.x, y: anchor.y + 40 });
    } catch (error) {
      setPopover({ title: t('actions.translate'), text: error.message, loading: false, x: anchor.x, y: anchor.y + 40 });
    }
  }, [api, selPos, selection, t]);

  const openEditor = useCallback(
    (withQuote) => {
      const block = selection?.block ?? null;
      const section = doc?.outline?.find((item) => item.id === block?.sectionId);
      setEditor({
        text: '',
        kind: withQuote ? 'quote' : 'insight',
        quote: withQuote ? String(selection?.text ?? '') : '',
        section: section?.title ?? '',
        line: block?.line,
        page: block?.page,
      });
      setSelection(null);
      setSelPos(null);
    },
    [doc, selection],
  );

  const saveNote = useCallback(async () => {
    if (editor === null || selectedId === null) return;
    const text = editor.text.trim();
    if (text === '' && editor.quote.trim() === '') return;
    try {
      const value = await api.notesAppend(selectedId, {
        kind: editor.kind,
        text,
        quote: editor.quote,
        section: editor.section || undefined,
        page: Number.isFinite(editor.page) ? editor.page : undefined,
        line: Number.isFinite(editor.line) ? editor.line : undefined,
      });
      const noteValue = await api.notesRead(selectedId);
      setNotes({ path: noteValue.path ?? '', exists: noteValue.exists === true, markdown: noteValue.markdown ?? '' });
      setEditor(null);
      showToast(t('notes.saved', { path: value.path ?? '' }));
    } catch (error) {
      showToast(t('notes.failed', { message: error.message }), 'error');
    }
  }, [api, editor, selectedId, showToast, t]);

  const translateAll = useCallback(
    async (view) => {
      const token = translateToken.current + 1;
      translateToken.current = token;
      const pending = [];
      (view?.blocks ?? []).forEach((block, index) => {
        if (block.kind !== 'para') return;
        const text = String(block.text ?? '').trim();
        if (text.length < 2) return;
        if (translations[index] !== undefined) return;
        pending.push({ index, text });
      });
      const batch = pending.slice(0, 48);
      if (batch.length === 0) return;
      setTranslating({ done: 0, total: batch.length });
      let done = 0;
      for (let cursor = 0; cursor < batch.length; cursor += 2) {
        if (translateToken.current !== token) return;
        const slice = batch.slice(cursor, cursor + 2);
        await Promise.all(
          slice.map(async (item) => {
            try {
              const value = await api.translate(item.text);
              if (translateToken.current !== token) return;
              setTranslations((prev) => ({ ...prev, [item.index]: value.text ?? '' }));
            } catch (error) {
              if (translateToken.current !== token) return;
              setTranslations((prev) => ({ ...prev, [item.index]: `⚠ ${error.message}` }));
            }
          }),
        );
        done += slice.length;
        setTranslating({ done, total: batch.length });
      }
      setTranslating(null);
    },
    [api, translations],
  );

  const toggleBilingual = useCallback(() => {
    if (doc === null) return;
    setBilingual((previous) => {
      const next = !previous;
      if (next) translateAll(doc);
      else translateToken.current += 1;
      return next;
    });
  }, [doc, translateAll]);

  const openPreview = useCallback(async () => {
    if (doc === null) return;
    const sidebar = ctx.get('sidebarRight');
    if (sidebar === undefined || sidebar === null || typeof sidebar.openResource !== 'function') {
      showToast(t('reader.previewUnavailable'), 'error');
      return;
    }
    const sessionId = await resolveSessionId();
    if (sessionId === null) {
      showToast(t('reader.askUnavailable'), 'error');
      return;
    }
    const cwd = targets.find((item) => item.id === sessionId)?.cwd ?? '';
    try {
      const address = fileAddressFor(sessionId, cwd, doc.path);
      if (doc.kind === 'tex' && Number.isFinite(lastLine)) sidebar.openResource(address, { params: { line: lastLine } });
      else sidebar.openResource(address);
    } catch (error) {
      showToast(error.message, 'error');
    }
  }, [ctx, doc, lastLine, resolveSessionId, showToast, t, targets]);

  const copyPath = useCallback(async () => {
    if (doc === null) return;
    try {
      await navigator.clipboard.writeText(doc.path);
      showToast(t('reader.copied'));
    } catch (error) {
      showToast(t('reader.copyFailed'), 'error');
    }
  }, [doc, showToast, t]);

  // 选区跟踪：只在正文区内生效
  useEffect(() => {
    const container = articleRef.current;
    if (container === null) return undefined;
    const onMouseUp = (event) => {
      if (event.target !== null && typeof event.target.closest === 'function' && event.target.closest('.pr-selbar')) return;
      const current = window.getSelection();
      if (current === null || current.isCollapsed) {
        setSelection(null);
        setSelPos(null);
        return;
      }
      const text = current.toString().trim();
      if (text.length < 2) {
        setSelection(null);
        setSelPos(null);
        return;
      }
      const range = current.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const element = node.nodeType === 3 ? node.parentElement : node;
      const pdfPageEl = element?.closest?.('[data-pdf-page]') ?? null;
      if (pdfPageEl !== null) {
        const page = Number(pdfPageEl.getAttribute('data-pdf-page'));
        if (Number.isFinite(page)) {
          const section = sectionForPage(doc?.outline, page);
          const rect = range.getBoundingClientRect();
          const x = Math.min(Math.max(rect.left + rect.width / 2, 140), window.innerWidth - 140);
          const y = Math.min(Math.max(rect.top - 6, 56), window.innerHeight - 12);
          setSelection({ text, index: -1, block: { page, sectionId: section?.id } });
          setSelPos({ x, y });
          return;
        }
      }
      const holder = element?.closest?.('[data-pr-block]');
      const index = holder === null || holder === undefined ? -1 : Number(holder.getAttribute('data-pr-block'));
      const block = index >= 0 ? doc?.blocks?.[index] ?? null : null;
      const rect = range.getBoundingClientRect();
      const x = Math.min(Math.max(rect.left + rect.width / 2, 140), window.innerWidth - 140);
      const y = Math.min(Math.max(rect.top - 6, 56), window.innerHeight - 12);
      setSelection({ text, index, block });
      setSelPos({ x, y });
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setSelection(null);
        setSelPos(null);
        setPopover(null);
      }
    };
    container.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [doc]);

  // 目录弹窗：Esc 关闭
  useEffect(() => {
    if (!rootDialog) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') closeRootDialog();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [rootDialog, closeRootDialog]);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === '') return papers;
    return papers.filter(
      (paper) =>
        String(paper.title ?? '').toLowerCase().includes(needle) ||
        String(paper.relPath ?? '').toLowerCase().includes(needle),
    );
  }, [filter, papers]);

  const parsedNotes = useMemo(() => parseNotes(notes.markdown), [notes.markdown]);
  const selectedPaper = papers.find((paper) => paper.id === selectedId) ?? null;

  const jumpTo = useCallback(
    (section) => {
      if (doc?.kind === 'pdf' && pdfView === 'pages') {
        if (Number.isFinite(section?.page)) pdfNavRef.current?.goToPage?.(section.page);
        return;
      }
      if (Number.isFinite(section.line)) setLastLine(section.line);
      const node = window.document.getElementById(`pr-sec-${section.id}`);
      if (node !== null && typeof node.scrollIntoView === 'function') node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [doc, pdfView],
  );

  const button = (label, onClick, options = {}) =>
    h(
      'button',
      {
        type: 'button',
        className: `pr-btn${options.icon ? ' pr-btn-icon' : ''}${options.ghost ? ' pr-btn-ghost' : ''}`,
        title: options.title ?? label,
        'data-active': options.active === true ? 'true' : undefined,
        disabled: options.disabled === true,
        onClick,
      },
      label,
    );

  const renderBlock = (block, index) => {
    const line = Number.isFinite(block.line) ? `L${block.line}` : Number.isFinite(block.page) ? `p.${block.page}` : '';
    const translation = bilingual ? translations[index] : undefined;
    const translated =
      translation !== undefined && translation !== ''
        ? h('div', { className: 'pr-trans', key: `tr-${index}` }, translation)
        : null;
    const lineChip =
      line !== '' && (block.kind === 'heading' || block.kind === 'theorem' || block.kind === 'proof')
        ? h('span', { className: 'pr-block-line' }, line)
        : null;

    if (block.kind === 'heading') {
      const tag = block.level === 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4';
      return h(
        tag,
        {
          key: index,
          className: 'pr-h',
          'data-level': block.level,
          'data-pr-block': index,
          id: `pr-sec-${block.sectionId}`,
        },
        lineChip,
        renderRich(block.text, `h${index}`),
      );
    }
    if (block.kind === 'page') {
      return h('div', { key: index, className: 'pr-page', 'data-pr-block': index }, t('label.page', { page: block.page }));
    }
    if (block.kind === 'math') {
      return h(
        'div',
        { key: index, className: 'pr-math', 'data-pr-block': index },
        renderMath(block.text, true),
        translation === undefined ? null : translated,
      );
    }
    if (block.kind === 'theorem') {
      return h(
        'div',
        { key: index, className: 'pr-theorem', 'data-pr-block': index },
        h(
          'div',
          { className: 'pr-theorem-head' },
          lineChip,
          `${block.name}${block.number ? ` ${block.number}` : ''}`,
          block.title ? h('span', { className: 'pr-subtle' }, ` — ${block.title}`) : null,
        ),
        h('div', { className: 'pr-p' }, renderRich(block.text, `t${index}`)),
        translated,
      );
    }
    if (block.kind === 'proof') {
      return h(
        'div',
        { key: index, className: 'pr-proof', 'data-pr-block': index },
        lineChip,
        h('span', { className: 'pr-proof-label' }, 'Proof.'),
        h('span', null, renderRich(block.text, `pf${index}`)),
        translated,
      );
    }
    return h(
      'div',
      { key: index, className: 'pr-body-block', 'data-pr-block': index },
      h('p', { className: 'pr-p' }, renderRich(block.text, `p${index}`)),
      translated,
    );
  };

  return h(
    'div',
    { className: 'pr-panel' },
    // ── 左：论文库 ─────────────────────────────────────────────
    h(
      'div',
      { className: 'pr-col pr-col-library' },
      h(
        'div',
        { className: 'pr-colhead' },
        h('div', { className: 'pr-colhead-title' }, t('library.title')),
        button('⟳', () => reloadList(), { icon: true, ghost: true, title: t('library.refresh') }),
      ),
      boot.loading
        ? h('div', { className: 'pr-loading' }, h('span', { className: 'pr-spinner' }), t('library.scanning'))
        : null,
      boot.error !== null ? h('div', { className: 'pr-error' }, boot.error) : null,
      h(
        'div',
        { className: 'pr-rootbar' },
        h(
          'select',
          {
            className: 'pr-select',
            value: root ?? '',
            title: t('library.root'),
            onChange: (event) => {
              const next = event.target.value;
              setRoot(next === '' ? null : next);
              reloadList(next === '' ? undefined : next);
            },
          },
          ...(boot.roots ?? []).map((entry) =>
            h(
              'option',
              { key: entry.path, value: entry.path },
              `${entry.source === 'cwd' ? `${t('library.roots.sourceCwd')} · ` : ''}${entry.path}${entry.exists === false ? ' (—)' : ''}`,
            ),
          ),
        ),
        button('＋', openRootDialog, { icon: true, ghost: true, title: t('library.roots.add') }),
        button('⚙', openRootDialog, { icon: true, ghost: true, title: t('library.roots.manage') }),
      ),
      h('input', {
        className: 'pr-input',
        value: filter,
        placeholder: t('library.search'),
        onChange: (event) => setFilter(event.target.value),
      }),
      h(
        'div',
        { className: 'pr-list' },
        listLoading ? h('div', { className: 'pr-loading' }, h('span', { className: 'pr-spinner' }), t('library.scanning')) : null,
        !listLoading && filtered.length === 0
          ? h(
              'div',
              { className: 'pr-empty' },
              t('library.empty'),
              h('div', { className: 'pr-subtle', style: { marginTop: 6, fontSize: 12 } }, t('library.emptyHint')),
            )
          : null,
        ...filtered.map((paper) =>
          h(
            'button',
            {
              key: paper.id,
              type: 'button',
              className: 'pr-item',
              'data-active': paper.id === selectedId ? 'true' : undefined,
              onClick: () => selectPaper(paper),
            },
            h('div', { className: 'pr-item-title' }, paper.title || paper.relPath),
            h(
              'div',
              { className: 'pr-item-meta' },
              h('span', { className: `pr-badge${paper.kind === 'tex' ? ' pr-badge-tex' : ''}` }, paper.kind === 'tex' ? 'TeX' : 'PDF'),
              h('span', null, formatBytes(paper.bytes)),
              h('span', null, formatDate(paper.mtime)),
            ),
          ),
        ),
      ),
    ),

    // ── 中：阅读区 ─────────────────────────────────────────────
    h(
      'div',
      { className: 'pr-col' },
      doc === null
        ? h('div', { className: 'pr-empty' }, docState === 'loading' ? h('div', { className: 'pr-loading' }, h('span', { className: 'pr-spinner' }), t('reader.loading')) : t('reader.placeholder'))
        : h(
            'div',
            { className: 'pr-doc' },
            h(
              'div',
              { className: 'pr-dochead' },
              h(
                'div',
                { className: 'pr-dochead-text' },
                h('div', { className: 'pr-doc-title' }, doc.title || selectedPaper?.title || ''),
                h(
                  'div',
                  { className: 'pr-doc-sub', title: doc.path },
                  [doc.authors, doc.path].filter((part) => typeof part === 'string' && part !== '').join(' · '),
                ),
              ),
              h(
                'div',
                { className: 'pr-doc-actions' },
                button('☰', () => setOutlineOpen((value) => !value), {
                  icon: true,
                  ghost: true,
                  active: outlineOpen,
                  title: t('reader.outline'),
                }),
                doc.kind === 'pdf'
                  ? button(
                      pdfView === 'pages' ? t('reader.pdfTextMode') : t('reader.pdfPageMode'),
                      () => setPdfView((value) => (value === 'pages' ? 'text' : 'pages')),
                      { ghost: true, title: pdfView === 'pages' ? t('reader.pdfTextModeHint') : t('reader.pdfPageModeHint') },
                    )
                  : null,
                button(t('reader.bilingual'), toggleBilingual, {
                  active: bilingual,
                  disabled: doc.kind === 'pdf' && (doc.blocks.length === 0 || pdfView === 'pages'),
                  title: bilingual ? t('reader.bilingualOff') : t('reader.bilingual'),
                }),
                button('↗', openPreview, { icon: true, ghost: true, title: t('reader.openInPreview') }),
                button('⧉', copyPath, { icon: true, ghost: true, title: t('reader.copyPath') }),
              ),
            ),
            translating !== null
              ? h(
                  'div',
                  { className: 'pr-loading', style: { padding: '6px 18px', fontSize: 12 } },
                  h('span', { className: 'pr-spinner' }),
                  `${t('reader.translating')} ${translating.done}/${translating.total}`,
                )
              : null,
            doc.error !== null && doc.error !== undefined && !(doc.kind === 'pdf' && pdfView === 'pages')
              ? h(
                  'div',
                  { className: 'pr-error' },
                  doc.error.code === 'pdftotext-missing' ? t('reader.pdfNoTool') : doc.error.message,
                )
              : null,
            doc.kind === 'pdf' && doc.hasText === false && pdfView === 'text' && (doc.error === null || doc.error === undefined)
              ? h('div', { className: 'pr-error' }, t('reader.pdfNoText'))
              : null,
            h(
              'div',
              { className: 'pr-main', 'data-outline': outlineOpen ? 'true' : 'false' },
              h(
                'div',
                { className: 'pr-outline' },
                h('div', { className: 'pr-outline-head' }, t('reader.outline')),
                ...(doc.outline ?? []).map((section) =>
                  h(
                    'button',
                    {
                      key: section.id,
                      type: 'button',
                      className: 'pr-outline-item',
                      'data-level': section.level,
                      title: section.title,
                      onClick: () => jumpTo(section),
                    },
                    section.title,
                  ),
                ),
                (doc.outline ?? []).length === 0 ? h('div', { className: 'pr-subtle', style: { fontSize: 12, padding: '4px 6px' } }, t('reader.emptyOutline')) : null,
              ),
              h(
                'div',
                { className: `pr-article${doc.kind === 'pdf' && pdfView === 'pages' ? ' pr-article-pdf' : ''}`, ref: articleRef },
                doc.kind === 'pdf' && pdfView === 'pages'
                  ? h(PdfReader, { key: doc.id, doc, t, navRef: pdfNavRef })
                  : h(
                      'div',
                      { className: 'pr-article-inner' },
                      ...(doc.blocks ?? []).map((block, index) => renderBlock(block, index)),
                      doc.truncated ? h('div', { className: 'pr-subtle', style: { marginTop: 16, fontSize: 12 } }, t('reader.truncated')) : null,
                    ),
              ),
            ),
          ),
    ),

    // ── 右：笔记 ───────────────────────────────────────────────
    h(
      'div',
      { className: 'pr-col pr-col-notes' },
      h(
        'div',
        { className: 'pr-colhead' },
        h('div', { className: 'pr-colhead-title' }, t('notes.title')),
        parsedNotes.entries.length > 0
          ? h('span', { className: 'pr-subtle', style: { fontSize: 11 } }, t('notes.count', { count: parsedNotes.entries.length }))
          : null,
        button('＋', () => openEditor(false), { icon: true, ghost: true, title: t('notes.add') }),
      ),
      h(
        'div',
        { className: 'pr-notes-list' },
        notes.path !== ''
          ? h('div', { className: 'pr-subtle', style: { fontSize: 11, padding: '0 0 6px', wordBreak: 'break-all' } }, notes.path)
          : null,
        parsedNotes.entries.length === 0
          ? h('div', { className: 'pr-empty', style: { padding: '24px 8px' } }, t('notes.empty'))
          : null,
        ...parsedNotes.entries.map((entry, index) =>
          h(
            'div',
            { key: index, className: 'pr-note' },
            h('div', { className: 'pr-note-head' }, entry.headline),
            entry.quote !== '' ? h('div', { className: 'pr-note-quote' }, entry.quote) : null,
            entry.text !== '' ? h('div', { className: 'pr-note-body' }, entry.text) : null,
          ),
        ),
      ),
      editor !== null
        ? h(
            'div',
            { className: 'pr-editor' },
            editor.quote !== ''
              ? h('div', { className: 'pr-note-quote', style: { marginBottom: 6, maxHeight: 96, overflow: 'auto' } }, editor.quote)
              : null,
            h('textarea', {
              className: 'pr-textarea',
              value: editor.text,
              placeholder: t('notes.placeholder'),
              onChange: (event) => setEditor({ ...editor, text: event.target.value }),
              autoFocus: true,
            }),
            h(
              'div',
              { className: 'pr-editor-actions' },
              button(t('notes.cancel'), () => setEditor(null), { ghost: true }),
              button(t('notes.save'), saveNote),
            ),
          )
        : null,
    ),

    // ── 浮层 ──────────────────────────────────────────────────
    selection !== null && selPos !== null
      ? h(
          'div',
          {
            className: 'pr-selbar',
            style: { left: selPos.x, top: selPos.y },
            onMouseDown: (event) => event.preventDefault(),
          },
          button(t('actions.explain'), () => ask('explain')),
          button(t('actions.critique'), () => ask('critique')),
          button(t('actions.review'), () => ask('review')),
          button(t('actions.translate'), translateSelection),
          button(t('actions.quote'), () => openEditor(true)),
        )
      : null,
    popover !== null
      ? h(
          'div',
          {
            className: 'pr-popover',
            style: {
              left: Math.min(Math.max(popover.x - 200, 12), window.innerWidth - 480),
              top: Math.min(Math.max(popover.y, 60), window.innerHeight - 240),
            },
          },
          h(
            'div',
            { className: 'pr-popover-head' },
            h('div', { className: 'pr-popover-title' }, popover.title),
            h('button', { type: 'button', className: 'pr-btn pr-btn-icon pr-btn-ghost', onClick: () => setPopover(null) }, '×'),
          ),
          popover.loading === true ? h('div', { className: 'pr-loading' }, h('span', { className: 'pr-spinner' }), t('reader.translating')) : popover.text,
        )
      : null,
    // ── 论文目录弹窗 ───────────────────────────────────────────
    rootDialog
      ? h(
          'div',
          {
            className: 'pr-modal-mask',
            onMouseDown: (event) => {
              if (event.target === event.currentTarget) closeRootDialog();
            },
          },
          h(
            'div',
            { className: 'pr-modal', role: 'dialog', 'aria-label': t('library.roots.title') },
            h('div', { className: 'pr-modal-title' }, t('library.roots.title')),
            h('div', { className: 'pr-modal-hint' }, t('library.roots.hint')),
            h(
              'div',
              { className: 'pr-rootlist' },
              ...(boot.roots ?? []).map((entry) =>
                h(
                  'div',
                  { key: entry.path, className: 'pr-rootrow' },
                  h(
                    'div',
                    { className: 'pr-rootpath' },
                    h('div', { className: 'pr-rootpathtext', title: entry.path }, entry.path),
                    h(
                      'div',
                      { className: 'pr-rootmeta' },
                      h(
                        'span',
                        { className: 'pr-badge' },
                        t(`library.roots.source${entry.source === 'cwd' ? 'Cwd' : entry.source === 'config' ? 'Config' : 'User'}`),
                      ),
                      h(
                        'span',
                        null,
                        entry.exists === false
                          ? t('library.roots.missing')
                          : t('library.roots.count', { count: entry.count ?? 0 }),
                      ),
                    ),
                  ),
                  entry.removable === false
                    ? h('span', { className: 'pr-rootfixed' }, t('library.roots.fixed'))
                    : h(
                        'button',
                        {
                          type: 'button',
                          className: 'pr-btn pr-btn-icon pr-btn-ghost',
                          title: t('library.roots.remove'),
                          disabled: rootBusy,
                          onClick: () => removeRoot(entry.path),
                        },
                        '×',
                      ),
                ),
              ),
            ),
            h(
              'div',
              { className: 'pr-modal-form' },
              h('div', { className: 'pr-modal-label' }, t('library.roots.addLabel')),
              h(
                'div',
                { className: 'pr-modal-row' },
                h('input', {
                  className: 'pr-modal-input',
                  value: rootDraft,
                  placeholder: t('library.roots.inputPlaceholder'),
                  onChange: (event) => {
                    setRootDraft(event.target.value);
                    setRootError('');
                  },
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') submitRoot();
                  },
                  autoFocus: true,
                }),
                button(t('library.roots.browse'), browseRoot, { ghost: true, disabled: rootBusy }),
              ),
              rootError !== '' ? h('div', { className: 'pr-modal-error' }, rootError) : null,
              h(
                'div',
                { className: 'pr-modal-actions' },
                button(t('library.roots.cancel'), closeRootDialog, { ghost: true, disabled: rootBusy }),
                button(t('library.roots.confirm'), submitRoot, { disabled: rootBusy || rootDraft.trim() === '' }),
              ),
            ),
          ),
        )
      : null,
    toast !== null ? h('div', { className: 'pr-toast', 'data-kind': toast.kind }, toast.text) : null,
  );
}
