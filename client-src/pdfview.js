/**
 * PDF 页面阅读器：pdf.js 按需加载 + 连续滚动 + 缩放/适宽 + 文本层选区。
 *
 * pdf.js 运行时由宿主的 `/paper-reader/static/pdfjs/` 路由提供（见 lib/http.js），
 * 打开 PDF 时才 `import()`，不拖慢面板首次加载。
 */
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react';

export const PDFJS_BASE = '/paper-reader/static/pdfjs/';
export const PDF_STORAGE_PREFIX = 'dsh-paper-reader:pdf:';

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
const MAX_CANVAS_PIXELS = 12_000_000;
const ZOOM_STEP = 1.12;

let enginePromise = null;

/** 懒加载 pdf.js 主包；失败后允许下次重试。 */
export function loadPdfEngine() {
  if (enginePromise === null) {
    const url = `${PDFJS_BASE}build/pdf.min.mjs`;
    enginePromise = import(/* @vite-ignore */ url).catch((error) => {
      enginePromise = null;
      throw error;
    });
  }
  return enginePromise;
}

/** 面板里的 PDF 字节流地址（宿主校验路径必须位于论文根目录内）。 */
export function pdfFileUrl(filePath) {
  return `/paper-reader/file?path=${encodeURIComponent(String(filePath ?? ''))}`;
}

export function clampScale(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(number * 100) / 100));
}

/** 读回上次的页码/缩放；坏数据一律当作没有。 */
export function readProgress(storage, id) {
  if (storage === null || storage === undefined || id === null || id === undefined) return null;
  try {
    const raw = storage.getItem(`${PDF_STORAGE_PREFIX}${id}`);
    if (typeof raw !== 'string' || raw === '') return null;
    const value = JSON.parse(raw);
    const page = Number.isInteger(value?.page) && value.page > 0 ? value.page : null;
    const scale = Number.isFinite(value?.scale) ? clampScale(value.scale) : null;
    const fit = typeof value?.fit === 'boolean' ? value.fit : null;
    if (page === null && scale === null && fit === null) return null;
    return { page: page ?? 1, scale: scale ?? 1, fit: fit ?? true };
  } catch {
    return null;
  }
}

export function writeProgress(storage, id, value) {
  if (storage === null || storage === undefined || id === null || id === undefined) return;
  try {
    storage.setItem(
      `${PDF_STORAGE_PREFIX}${id}`,
      JSON.stringify({ page: value.page, scale: value.scale, fit: value.fit === true }),
    );
  } catch {
    /* 隐私模式/配额满：记住阅读位置只是锦上添花 */
  }
}

/** 按页码找最近的章节标题（用于「问 AI」的出处）。 */
export function sectionForPage(outline, page) {
  if (!Array.isArray(outline) || !Number.isFinite(page)) return null;
  let hit = null;
  for (const section of outline) {
    if (!Number.isFinite(section?.page)) continue;
    if (section.page <= page) hit = section;
    else break;
  }
  return hit;
}

/** 测试/无浏览器环境下不碰 Worker、Canvas、动态 import。 */
export function browserSupportsPdf() {
  return (
    typeof window !== 'undefined' &&
    window.document !== undefined &&
    typeof window.document.createElement === 'function' &&
    typeof window.Worker !== 'undefined' &&
    typeof window.URL !== 'undefined'
  );
}

function requestFrame(callback) {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
  return setTimeout(callback, 16);
}

function cancelFrame(handle) {
  if (handle === null) return;
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  else clearTimeout(handle);
}

function PdfPage({ pdfjs, pdf, pageNumber, width, height, scale, active, pageElRef }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const textRef = useRef(null);
  const [status, setStatus] = useState('idle');

  const cssWidth = Math.max(1, Math.round(width * scale));
  const cssHeight = Math.max(1, Math.round(height * scale));

  useEffect(() => {
    if (active !== true || pdf === null || pdfjs === null) return undefined;
    let cancelled = false;
    let task = null;
    let layer = null;
    const canvas = canvasRef.current;
    const container = textRef.current;
    if (container !== null) container.innerHTML = '';

    (async () => {
      setStatus('rendering');
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const context = canvas?.getContext?.('2d');
        if (context === null || context === undefined) throw new Error('canvas 2d context 不可用');
        let ratio = Math.min(2, window.devicePixelRatio || 1);
        const pixels = cssWidth * cssHeight * ratio * ratio;
        if (pixels > MAX_CANVAS_PIXELS) {
          ratio = Math.max(0.5, ratio * Math.sqrt(MAX_CANVAS_PIXELS / pixels));
        }
        const viewport = page.getViewport({ scale: scale * ratio });
        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        task = page.render({ canvasContext: context, viewport });
        await task.promise;
        if (cancelled) return;

        if (container !== null && typeof pdfjs.TextLayer === 'function') {
          container.style.setProperty('--scale-factor', String(scale));
          layer = new pdfjs.TextLayer({
            textContentSource: page.streamTextContent(),
            container,
            viewport: page.getViewport({ scale }),
          });
          await layer.render();
        }
        if (!cancelled) setStatus('done');
      } catch (error) {
        if (cancelled) return;
        if (error?.name === 'RenderingCancelledException') return;
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      try {
        layer?.cancel?.();
      } catch {
        /* 已取消 */
      }
      try {
        task?.cancel();
      } catch {
        /* 已结束 */
      }
      if (canvas !== null) {
        canvas.width = 0;
        canvas.height = 0;
      }
      if (container !== null) container.innerHTML = '';
    };
  }, [active, pdf, pdfjs, pageNumber, scale, cssWidth, cssHeight]);

  return h(
    'div',
    {
      ref: (node) => {
        wrapRef.current = node;
        pageElRef(node);
      },
      className: 'pr-pdf-page',
      'data-pdf-page': pageNumber,
      'data-pdf-status': status,
      style: { width: `${cssWidth}px`, height: `${cssHeight}px` },
    },
    h('canvas', { ref: canvasRef, className: 'pr-pdf-canvas', width: 0, height: 0 }),
    h('div', { ref: textRef, className: 'pr-pdf-text' }),
    active !== true
      ? h('div', { className: 'pr-pdf-placeholder', 'aria-hidden': true })
      : status === 'rendering'
        ? h('div', { className: 'pr-pdf-pageload', 'aria-hidden': true })
        : null,
  );
}

export function PdfReader({ doc, t, navRef }) {
  const storage = useMemo(() => {
    try {
      return typeof window !== 'undefined' ? window.localStorage ?? null : null;
    } catch {
      return null;
    }
  }, []);

  const [reloadToken, setReloadToken] = useState(0);
  const [engine, setEngine] = useState({ status: 'loading', pdfjs: null, pdf: null, error: '' });
  const [dims, setDims] = useState([]);
  const [scale, setScale] = useState(1.2);
  const [fit, setFit] = useState(true);
  const [current, setCurrent] = useState(1);
  const [pageDraft, setPageDraft] = useState('1');
  const [visible, setVisible] = useState(() => new Set([0]));
  const [viewportWidth, setViewportWidth] = useState(0);

  const scrollRef = useRef(null);
  const pagesRef = useRef(null);
  const pageEls = useRef([]);
  const savedPageRef = useRef(1);
  const frameRef = useRef(null);

  const pageCount = dims.length;
  const baseWidth = dims[0]?.width ?? 612;
  const fitScale = clampScale(((viewportWidth > 0 ? viewportWidth : 820) - 40) / baseWidth);
  const effectiveScale = fit ? fitScale : clampScale(scale);
  const maxPageWidth = useMemo(
    () => (dims.length === 0 ? 0 : Math.max(...dims.map((dim) => dim.width)) * effectiveScale),
    [dims, effectiveScale],
  );

  // 1) 打开文档：拿页数与每页原始尺寸
  useEffect(() => {
    let alive = true;
    let pdf = null;
    setEngine({ status: 'loading', pdfjs: null, pdf: null, error: '' });
    setDims([]);
    setVisible(new Set([0]));

    const saved = readProgress(storage, doc.id);
    savedPageRef.current = saved?.page ?? 1;
    setScale(saved?.scale ?? 1.2);
    setFit(saved?.fit !== false);

    if (!browserSupportsPdf()) {
      setEngine({ status: 'error', pdfjs: null, pdf: null, error: t('reader.pdfNoBrowser') });
      return undefined;
    }

    (async () => {
      try {
        const pdfjs = await loadPdfEngine();
        if (!alive) return;
        pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}build/pdf.worker.min.mjs`;
        const task = pdfjs.getDocument({
          url: pdfFileUrl(doc.path),
          cMapUrl: `${PDFJS_BASE}cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${PDFJS_BASE}standard_fonts/`,
          isEvalSupported: false,
        });
        pdf = await task.promise;
        if (!alive) {
          await pdf.destroy();
          return;
        }
        const pages = new Array(pdf.numPages);
        let cursor = 0;
        const workers = Array.from({ length: Math.min(6, pdf.numPages) }, async () => {
          while (alive && cursor < pdf.numPages) {
            const index = cursor;
            cursor += 1;
            try {
              const page = await pdf.getPage(index + 1);
              const viewport = page.getViewport({ scale: 1 });
              pages[index] = { width: viewport.width, height: viewport.height };
            } catch {
              pages[index] = { width: 612, height: 792 };
            }
          }
        });
        await Promise.all(workers);
        if (!alive) return;
        setDims(pages);
        setEngine({ status: 'ready', pdfjs, pdf, error: '' });
        setCurrent(Math.min(Math.max(1, savedPageRef.current), pages.length || 1));
      } catch (error) {
        if (!alive) return;
        const message = String(error?.message ?? error);
        setEngine({ status: 'error', pdfjs: null, pdf: null, error: message });
      }
    })();

    return () => {
      alive = false;
      const handle = pdf;
      if (handle !== null && typeof handle.destroy === 'function') {
        Promise.resolve(handle.destroy()).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, doc.path, storage, reloadToken]);

  // 2) 恢复上次页码
  useEffect(() => {
    if (engine.status !== 'ready' || dims.length === 0) return undefined;
    let alive = true;
    const frame = requestFrame(() => {
      if (!alive) return;
      const target = Math.min(Math.max(1, savedPageRef.current), dims.length);
      const element = pageEls.current[target - 1];
      const box = scrollRef.current;
      if (element !== null && element !== undefined && box !== null) {
        box.scrollTop = Math.max(0, element.offsetTop - 8);
      }
      setCurrent(target);
    });
    return () => {
      alive = false;
      cancelFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.status, dims.length]);

  // 3) 容器宽度（适宽、ResizeObserver）
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null || engine.status !== 'ready') return undefined;
    const measure = () => setViewportWidth(node.clientWidth);
    measure();
    let observer;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(node);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', measure);
    }
    return () => {
      observer?.disconnect();
      if (typeof window !== 'undefined') window.removeEventListener('resize', measure);
    };
  }, [engine.status, dims.length]);

  // 4) 可见页（懒渲染）。缩放后无需重建：observer 会自动重算。
  useEffect(() => {
    if (engine.status !== 'ready' || dims.length === 0) return undefined;
    const root = scrollRef.current;
    const container = pagesRef.current;
    if (root === null || container === null) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(new Set(Array.from({ length: Math.min(3, dims.length) }, (_value, index) => index)));
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible((previous) => {
          const next = new Set(previous);
          for (const entry of entries) {
            const page = Number(entry.target.getAttribute('data-pdf-page'));
            if (!Number.isFinite(page)) continue;
            if (entry.isIntersecting) next.add(page - 1);
            else next.delete(page - 1);
          }
          return next;
        });
      },
      { root, rootMargin: '900px 0px', threshold: 0 },
    );
    for (const node of Array.from(container.children)) observer.observe(node);
    return () => observer.disconnect();
  }, [engine.status, dims]);

  // 5) 滚动 → 当前页
  const onScroll = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestFrame(() => {
      frameRef.current = null;
      const box = scrollRef.current;
      if (box === null) return;
      const top = box.scrollTop + 24;
      let next = 1;
      pageEls.current.forEach((element, index) => {
        if (element !== null && element !== undefined && element.offsetTop <= top) next = index + 1;
      });
      setCurrent((previous) => (previous === next ? previous : next));
    });
  }, []);

  useEffect(
    () => () => {
      cancelFrame(frameRef.current);
      frameRef.current = null;
    },
    [],
  );

  const goToPage = useCallback(
    (page, smooth = true) => {
      if (pageCount === 0) return;
      const target = Math.min(Math.max(1, Math.round(Number(page) || 1)), pageCount);
      const element = pageEls.current[target - 1];
      const box = scrollRef.current;
      if (element === null || element === undefined || box === null) return;
      const top = Math.max(0, element.offsetTop - 8);
      if (typeof box.scrollTo === 'function') box.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
      else box.scrollTop = top;
      setCurrent(target);
    },
    [pageCount],
  );

  useEffect(() => {
    setPageDraft(String(current));
  }, [current]);

  // 6) 记住阅读位置
  useEffect(() => {
    if (engine.status !== 'ready' || pageCount === 0) return;
    writeProgress(storage, doc.id, { page: current, scale: effectiveScale, fit });
  }, [engine.status, pageCount, current, effectiveScale, fit, storage, doc.id]);

  useEffect(() => {
    if (navRef === undefined || navRef === null) return undefined;
    navRef.current = { goToPage, pageCount };
    return () => {
      if (navRef.current?.goToPage === goToPage) navRef.current = null;
    };
  }, [navRef, goToPage, pageCount]);

  const applyZoom = useCallback(
    (nextScale) => {
      setFit(false);
      setScale(clampScale(nextScale));
    },
    [],
  );

  const zoomIn = () => applyZoom(effectiveScale * ZOOM_STEP);
  const zoomOut = () => applyZoom(effectiveScale / ZOOM_STEP);
  const resetZoom = () => applyZoom(1);
  const toggleFit = () => {
    if (fit) applyZoom(effectiveScale);
    else setFit(true);
  };

  const commitPageDraft = useCallback(() => {
    const parsed = Number.parseInt(String(pageDraft), 10);
    if (!Number.isFinite(parsed)) {
      setPageDraft(String(current));
      return;
    }
    goToPage(parsed);
  }, [current, goToPage, pageDraft]);

  if (engine.status === 'error') {
    return h(
      'div',
      { className: 'pr-pdf pr-pdf-failed' },
      h('div', { className: 'pr-error' }, t('reader.pdfFailed', { message: engine.error || 'unknown' })),
      h(
        'div',
        { className: 'pr-pdf-failed-actions' },
        h(
          'button',
          { type: 'button', className: 'pr-btn', onClick: () => setReloadToken((value) => value + 1) },
          t('reader.pdfRetry'),
        ),
      ),
      h('div', { className: 'pr-subtle', style: { fontSize: 12, maxWidth: 520, lineHeight: 1.6 } }, t('reader.pdfFailedHint')),
    );
  }

  if (engine.status === 'loading') {
    return h(
      'div',
      { className: 'pr-pdf pr-pdf-loading' },
      h('span', { className: 'pr-spinner' }),
      h('span', null, t('reader.pdfLoading')),
    );
  }

  return h(
    'div',
    { className: 'pr-pdf' },
    h(
      'div',
      { className: 'pr-pdf-toolbar' },
      h(
        'button',
        {
          type: 'button',
          className: 'pr-btn pr-btn-icon',
          title: t('reader.pdfPrev'),
          disabled: current <= 1,
          onClick: () => goToPage(current - 1),
        },
        '◀',
      ),
      h(
        'div',
        { className: 'pr-pdf-pager' },
        h('input', {
          className: 'pr-pdf-pageinput',
          value: pageDraft,
          inputMode: 'numeric',
          'aria-label': t('reader.pdfPageLabel'),
          onChange: (event) => setPageDraft(event.target.value.replace(/[^\d]/g, '')),
          onBlur: commitPageDraft,
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitPageDraft();
            }
          },
        }),
        h('span', { className: 'pr-pdf-pagetotal' }, `/ ${pageCount}`),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'pr-btn pr-btn-icon',
          title: t('reader.pdfNext'),
          disabled: current >= pageCount,
          onClick: () => goToPage(current + 1),
        },
        '▶',
      ),
      h('span', { className: 'pr-pdf-sep' }),
      h('button', { type: 'button', className: 'pr-btn pr-btn-icon', title: t('reader.pdfZoomOut'), onClick: zoomOut }, '−'),
      h(
        'button',
        { type: 'button', className: 'pr-btn pr-btn-ghost pr-pdf-zoom', title: t('reader.pdfResetZoom'), onClick: resetZoom },
        `${Math.round(effectiveScale * 100)}%`,
      ),
      h('button', { type: 'button', className: 'pr-btn pr-btn-icon', title: t('reader.pdfZoomIn'), onClick: zoomIn }, '＋'),
      h(
        'button',
        {
          type: 'button',
          className: 'pr-btn pr-btn-ghost',
          'data-active': fit ? 'true' : undefined,
          title: t('reader.pdfFit'),
          onClick: toggleFit,
        },
        t('reader.pdfFit'),
      ),
      h('span', { className: 'pr-pdf-spacer' }),
      h('span', { className: 'pr-pdf-hint' }, t('reader.pdfHint')),
    ),
    h(
      'div',
      { className: 'pr-pdf-scroll', ref: scrollRef, onScroll },
      h(
        'div',
        { className: 'pr-pdf-pages', ref: pagesRef, style: maxPageWidth > 0 ? { width: `${Math.round(maxPageWidth)}px` } : undefined },
        ...dims.map((dim, index) =>
          h(PdfPage, {
            key: index,
            pdfjs: engine.pdfjs,
            pdf: engine.pdf,
            pageNumber: index + 1,
            width: dim.width,
            height: dim.height,
            scale: effectiveScale,
            active: visible.has(index),
            pageElRef: (node) => {
              pageEls.current[index] = node;
            },
          }),
        ),
      ),
    ),
  );
}
