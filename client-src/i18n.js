import en from '../locale/en.json';
import zh from '../locale/zh.json';

export const NS = 'paper-reader';
export const DICTS = { zh: zh.ui, en: en.ui };

/** 取嵌套 key：`library.title`。 */
export function lookup(dict, key) {
  if (dict === undefined || dict === null) return undefined;
  let cursor = dict;
  for (const part of String(key).split('.')) {
    if (cursor === undefined || cursor === null) return undefined;
    cursor = cursor[part];
  }
  return typeof cursor === 'string' ? cursor : undefined;
}

/** `{count}` 占位替换。 */
export function interpolate(template, params) {
  if (typeof template !== 'string') return '';
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name) => {
    const value = params[name];
    return value === undefined || value === null ? '' : String(value);
  });
}

export function normalizeLocale(active) {
  const value = String(active ?? '').toLowerCase();
  return value.startsWith('en') ? 'en' : 'zh';
}

/**
 * 翻译函数：优先宿主 locale 服务（可随语言切换即时生效），
 * 宿主没有 locale 时退回内置字典。
 */
export function createT(ctx) {
  return (key, params) => {
    let service;
    try {
      service = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
    } catch {
      service = undefined;
    }
    if (service !== undefined && typeof service.bind === 'function') {
      try {
        const translate = service.bind(NS);
        if (typeof translate === 'function') {
          const value = translate(key);
          if (typeof value === 'string' && value !== key) return interpolate(value, params);
        }
      } catch {
        /* 退回内置字典 */
      }
    }
    let active;
    try {
      active = service?.getLocale?.()?.active;
    } catch {
      active = undefined;
    }
    const dict = DICTS[normalizeLocale(active)] ?? DICTS.zh;
    return interpolate(lookup(dict, key) ?? key, params);
  };
}

export function currentLocale(ctx) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
    return normalizeLocale(service?.getLocale?.()?.active);
  } catch {
    return 'zh';
  }
}
