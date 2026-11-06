import { Component, createElement } from 'react';
import { PanelApi } from './api.js';
import { currentLocale, createT, DICTS, NS } from './i18n.js';
import { PaperReaderPanel } from './panel.js';
import { PANEL_CSS, STYLE_ID } from './styles.js';

export const inject = ['slots'];

/**
 * 兜底错误边界：面板内任何渲染异常都只影响这一块，
 * 不会把 slot 条目整个打成空白。
 */
class PanelBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error !== null) {
      return createElement(
        'div',
        { style: { padding: '24px', fontSize: '13px', color: 'var(--dsw-alias-state-error-primary, #cf222e)' } },
        `论文阅读器渲染失败：${String(this.state.error?.message ?? this.state.error)}`,
      );
    }
    return this.props.children;
  }
}

/** 注册一次样式表；返回注销。 */
function ensureStyle() {
  const existing = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`);
  if (existing !== null) return () => {};
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-paper-reader';
  tag.dataset.pluginCss = STYLE_ID;
  tag.textContent = PANEL_CSS;
  document.head.appendChild(tag);
  return () => {
    if (tag.parentNode !== null) tag.parentNode.removeChild(tag);
  };
}

/** 侧栏图标：一页带公式高亮的论文。 */
function PanelIcon({ size = 18, active = false }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': true,
      style: { display: 'block' },
    },
    createElement('path', {
      d: 'M6.2 3.4h7.1L18 8.1V19.8a.9.9 0 0 1-.9.9H6.2a.9.9 0 0 1-.9-.9V4.3a.9.9 0 0 1 .9-.9Z',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinejoin: 'round',
      opacity: active ? 1 : 0.85,
    }),
    createElement('path', {
      d: 'M13.1 3.6v4.6h4.7',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinejoin: 'round',
      opacity: active ? 1 : 0.85,
    }),
    createElement('path', {
      d: 'M8.7 11.5h6.6M8.7 14.2h6.6M8.7 16.9h3.9',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      opacity: active ? 1 : 0.8,
    }),
  );
}

/**
 * 记住“当前在看的会话”：全局面板会替换对话列，
 * 所以要在插件加载时就订阅右侧栏的 mounted，缓存最后一次有会话的值。
 */
function createSessionTracker(ctx) {
  let last;
  let stop;
  const read = () => {
    try {
      const sidebar = ctx.get('sidebarRight');
      const mounted = sidebar?.mounted;
      const value = mounted?.getSnapshot?.();
      const id = typeof value === 'string' ? value : value?.sessionId ?? value?.id;
      if (typeof id === 'string' && id !== '') last = id;
    } catch {
      /* 没有 sidebarRight 的宿主直接跳过 */
    }
  };
  return {
    start() {
      read();
      try {
        const mounted = ctx.get('sidebarRight')?.mounted;
        if (mounted !== undefined && mounted !== null && typeof mounted.subscribe === 'function') {
          stop = mounted.subscribe(read);
        }
      } catch {
        stop = undefined;
      }
    },
    current() {
      read();
      return last;
    },
    dispose() {
      try {
        stop?.();
      } catch {
        /* 忽略 */
      }
      stop = undefined;
    },
  };
}

export function apply(ctx) {
  ctx.effect(() => ensureStyle(), 'paper-reader: styles');

  const locale = (() => {
    try {
      return ctx.get('locale');
    } catch {
      return undefined;
    }
  })();
  if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
    ctx.effect(() => {
      const disposers = [locale.register(NS, 'zh', DICTS.zh), locale.register(NS, 'en', DICTS.en)];
      return () => {
        for (const dispose of disposers) {
          try {
            dispose?.();
          } catch {
            /* 忽略 */
          }
        }
      };
    }, 'paper-reader: locale');
  }

  const tracker = createSessionTracker(ctx);
  tracker.start();
  ctx.effect(() => () => tracker.dispose(), 'paper-reader: session tracker');

  const api = new PanelApi(
    () => {
      try {
        return ctx.get('connection');
      } catch {
        return undefined;
      }
    },
    () => currentLocale(ctx),
  );
  const t = createT(ctx);

  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: 'paper-reader' }, (props) =>
      createElement(PanelBoundary, null, createElement(PaperReaderPanel, { api, ctx, t, tracker, ...(props ?? {}) })),
    ),
  );

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({ name: 'sidebar.panellist', id: 'paper-reader', order: 20, label: () => t('panel.title') }, (props) =>
      createElement(PanelIcon, { size: props?.size ?? 18, active: props?.active === true }),
    ),
  );
}
