export const STYLE_ID = 'dsh-paper-reader';

export const PANEL_CSS = `
.pr-panel {
  display: grid;
  grid-template-columns: 252px minmax(0, 1fr) 304px;
  height: 100%;
  min-height: 0;
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #1f2328);
  font-size: 13px;
  overflow: hidden;
}
.pr-panel * { box-sizing: border-box; }
.pr-panel button { font: inherit; color: inherit; }
.pr-col { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.pr-col-library { border-right: 1px solid var(--dsw-alias-border-l1, #eaeef2); background: var(--dsw-alias-bg-layer-1, #fafbfc); }
.pr-col-notes { border-left: 1px solid var(--dsw-alias-border-l1, #eaeef2); background: var(--dsw-alias-bg-layer-1, #fafbfc); }

.pr-colhead { display: flex; align-items: center; gap: 8px; padding: 10px 12px 8px; }
.pr-colhead-title { font-weight: 600; font-size: 13px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pr-subtle { color: var(--dsw-alias-label-secondary, #57606a); }

.pr-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  height: 26px; padding: 0 9px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1, #d0d7de);
  background: transparent; color: var(--dsw-alias-label-primary, #1f2328);
  font-size: 12px; white-space: nowrap;
}
.pr-btn:hover { background: var(--dsw-alias-bg-layer-2, #f3f4f6); }
.pr-btn:disabled { opacity: .45; cursor: default; }
.pr-btn[data-active="true"] { border-color: var(--dsw-alias-brand-primary, #247bbf); color: var(--dsw-alias-brand-primary, #247bbf); }
.pr-btn-icon { width: 26px; padding: 0; }
.pr-btn-ghost { border-color: transparent; }

.pr-input {
  width: calc(100% - 24px); margin: 0 12px 8px; height: 28px; padding: 0 8px;
  border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1, #d0d7de);
  background: var(--dsw-alias-bg-base, #fff); color: inherit; font: inherit; outline: none;
}
.pr-input:focus { border-color: var(--dsw-alias-brand-primary, #247bbf); }

.pr-rootbar { display: flex; gap: 6px; padding: 0 12px 6px; }
.pr-rootbar .pr-btn { height: 26px; }
.pr-select {
  flex: 1; min-width: 0; height: 26px; border-radius: 6px; padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l1, #d0d7de);
  background: var(--dsw-alias-bg-base, #fff); color: inherit; font: inherit;
}

/* 论文目录弹窗：加目录、移除目录、看每项论文数 */
.pr-modal-mask {
  position: fixed; inset: 0; z-index: 90; display: flex; align-items: center; justify-content: center;
  padding: 24px; background: rgba(15, 23, 42, .34);
}
.pr-modal {
  width: min(540px, 92vw); max-height: 78vh; overflow: auto; padding: 16px 18px; border-radius: 12px;
  background: var(--dsw-alias-bg-overlay, #fff); border: 1px solid var(--dsw-alias-border-l2, #d0d7de);
  box-shadow: 0 18px 48px rgba(15, 23, 42, .28);
}
.pr-modal-title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
.pr-modal-hint { font-size: 11.5px; line-height: 1.55; color: var(--dsw-alias-label-secondary, #57606a); margin-bottom: 10px; }
.pr-rootlist {
  display: flex; flex-direction: column; max-height: 34vh; overflow: auto;
  border: 1px solid var(--dsw-alias-border-l1, #eaeef2); border-radius: 8px; padding: 2px 10px;
}
.pr-rootrow { display: flex; align-items: flex-start; gap: 8px; padding: 8px 0; border-top: 1px solid var(--dsw-alias-border-l1, #eaeef2); }
.pr-rootrow:first-child { border-top: 0; }
.pr-rootpath { flex: 1; min-width: 0; }
.pr-rootpathtext { font-size: 12px; line-height: 1.45; word-break: break-all; }
.pr-rootmeta { display: flex; align-items: center; gap: 6px; margin-top: 3px; font-size: 11px; color: var(--dsw-alias-label-secondary, #57606a); }
.pr-rootfixed { font-size: 11px; color: var(--dsw-alias-label-secondary, #9aa4b2); white-space: nowrap; padding-top: 5px; }
.pr-modal-form { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1, #eaeef2); }
.pr-modal-label { font-size: 11.5px; font-weight: 600; margin-bottom: 6px; }
.pr-modal-row { display: flex; gap: 6px; align-items: center; }
.pr-modal-input {
  flex: 1; min-width: 0; height: 28px; padding: 0 8px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1, #d0d7de);
  background: var(--dsw-alias-bg-base, #fff); color: inherit; font: inherit; outline: none;
}
.pr-modal-input:focus { border-color: var(--dsw-alias-brand-primary, #247bbf); }
.pr-modal-error { margin-top: 8px; font-size: 12px; color: var(--dsw-alias-state-error-primary, #cf222e); white-space: pre-wrap; }
.pr-modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.pr-modal-actions .pr-btn { height: 28px; }

.pr-list { flex: 1; min-height: 0; overflow: auto; padding: 0 8px 12px; }
.pr-item {
  display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left;
  padding: 7px 8px; border-radius: 7px; border: 1px solid transparent;
  background: transparent; cursor: pointer;
}
.pr-item:hover { background: var(--dsw-alias-bg-layer-2, #f3f4f6); }
.pr-item[data-active="true"] { background: var(--dsw-alias-bg-layer-2, #eef2f7); border-color: var(--dsw-alias-border-l1, #d0d7de); }
.pr-item-title { font-size: 12.5px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.pr-item-meta { display: flex; gap: 6px; align-items: center; font-size: 11px; color: var(--dsw-alias-label-secondary, #57606a); }
.pr-badge {
  display: inline-block; padding: 0 5px; height: 15px; line-height: 15px; border-radius: 4px;
  font-size: 10px; font-weight: 600; letter-spacing: .03em;
  border: 1px solid var(--dsw-alias-border-l1, #d0d7de); color: var(--dsw-alias-label-secondary, #57606a);
}
.pr-badge-tex { border-color: var(--dsw-alias-brand-primary, #247bbf); color: var(--dsw-alias-brand-primary, #247bbf); }

.pr-main { display: grid; grid-template-columns: 196px minmax(0, 1fr); min-height: 0; flex: 1; }
.pr-main[data-outline="false"] { grid-template-columns: 0 minmax(0, 1fr); }
.pr-outline { border-right: 1px solid var(--dsw-alias-border-l1, #eaeef2); overflow: auto; padding: 6px 6px 16px; min-height: 0; }
.pr-main[data-outline="false"] .pr-outline { display: none; }
.pr-outline-item {
  display: block; width: 100%; text-align: left; padding: 4px 6px; border-radius: 5px;
  background: transparent; border: 0; cursor: pointer; font-size: 12px; line-height: 1.4;
  color: var(--dsw-alias-label-secondary, #57606a);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pr-outline-item:hover { background: var(--dsw-alias-bg-layer-2, #f3f4f6); color: var(--dsw-alias-label-primary, #1f2328); }
.pr-outline-item[data-level="1"] { font-weight: 600; color: var(--dsw-alias-label-primary, #1f2328); }
.pr-outline-item[data-level="2"] { padding-left: 16px; }
.pr-outline-item[data-level="3"] { padding-left: 26px; font-size: 11.5px; }
.pr-outline-head { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-secondary, #57606a); padding: 8px 6px 4px; }

.pr-doc { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.pr-dochead { display: flex; align-items: flex-start; gap: 8px; padding: 10px 18px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eaeef2); }
.pr-dochead-text { flex: 1; min-width: 0; }
.pr-doc-title { font-size: 14.5px; font-weight: 600; line-height: 1.35; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.pr-doc-sub { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #57606a); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pr-doc-actions { display: flex; gap: 4px; flex: 0 0 auto; }

.pr-article { flex: 1; min-height: 0; overflow: auto; padding: 14px 22px 120px; }
.pr-article-inner { max-width: 760px; margin: 0 auto; font-size: 13.5px; line-height: 1.72; }

/* PDF 页面阅读器（pdf.js）：连续滚动 + 适宽 + 文本层选区 */
.pr-article-pdf { padding: 0; overflow: hidden; display: flex; flex-direction: column; }
.pr-pdf { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.pr-pdf-toolbar {
  display: flex; align-items: center; gap: 4px; flex: 0 0 auto;
  padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, #eaeef2);
  background: var(--dsw-alias-bg-layer-1, #fafbfc); overflow-x: auto;
}
.pr-pdf-pager { display: flex; align-items: center; gap: 4px; }
.pr-pdf-pageinput {
  width: 46px; height: 24px; text-align: center; font: inherit; font-size: 12px;
  border-radius: 5px; border: 1px solid var(--dsw-alias-border-l1, #d0d7de);
  background: var(--dsw-alias-bg-base, #fff); color: inherit; outline: none;
}
.pr-pdf-pageinput:focus { border-color: var(--dsw-alias-brand-primary, #247bbf); }
.pr-pdf-pagetotal { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #57606a); white-space: nowrap; }
.pr-pdf-sep { width: 1px; height: 16px; margin: 0 3px; background: var(--dsw-alias-border-l1, #eaeef2); }
.pr-pdf-zoom { min-width: 50px; }
.pr-pdf-spacer { flex: 1; }
.pr-pdf-hint { font-size: 11px; color: var(--dsw-alias-label-secondary, #9aa4b2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pr-pdf-scroll { flex: 1; min-height: 0; overflow: auto; padding: 14px 0 48px; background: var(--dsw-alias-bg-layer-2, #e8ebf0); }
.pr-pdf-pages { position: relative; display: flex; flex-direction: column; align-items: center; gap: 14px; margin: 0 auto; }
.pr-pdf-page { position: relative; flex: 0 0 auto; overflow: hidden; background: #fff; box-shadow: 0 1px 4px rgba(15, 23, 42, .2); }
.pr-pdf-canvas { display: block; width: 100%; height: 100%; }
.pr-pdf-text {
  position: absolute; inset: 0; z-index: 1; overflow: hidden;
  line-height: 1; text-align: initial; transform-origin: 0 0;
  -webkit-text-size-adjust: none; text-size-adjust: none; caret-color: canvastext;
}
.pr-pdf-text span {
  position: absolute; white-space: pre; color: transparent;
  transform-origin: 0% 0%; cursor: text;
}
.pr-pdf-text span::selection { background: rgba(80, 130, 255, .35); }
.pr-pdf-text span.markedContent { top: 0; height: 0; }
.pr-pdf-placeholder { position: absolute; inset: 0; background: #fff; }
.pr-pdf-pageload {
  position: absolute; inset: 0; background: linear-gradient(100deg, #fff 30%, #f4f6f9 50%, #fff 70%);
  background-size: 200% 100%; animation: pr-pdf-shimmer 1.2s linear infinite;
}
@keyframes pr-pdf-shimmer { from { background-position: 150% 0; } to { background-position: -50% 0; } }
.pr-pdf-loading { flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--dsw-alias-label-secondary, #57606a); }
.pr-pdf-failed { flex: 1; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; padding: 0 24px; }
.pr-pdf-failed .pr-error { margin: 0 0 12px; max-width: 640px; }
.pr-pdf-failed-actions { display: flex; gap: 8px; margin-bottom: 12px; }
.pr-h { font-weight: 600; line-height: 1.35; margin: 22px 0 8px; scroll-margin-top: 12px; }
.pr-h[data-level="1"] { font-size: 16.5px; }
.pr-h[data-level="2"] { font-size: 14.5px; }
.pr-h[data-level="3"] { font-size: 13.5px; }
.pr-h:first-child { margin-top: 4px; }
.pr-p { margin: 0 0 10px; white-space: pre-wrap; word-break: break-word; }
.pr-p mark { background: transparent; color: inherit; }
.pr-block-line { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #9aa4b2); user-select: none; float: right; margin-left: 8px; }
.pr-math { margin: 10px 0 14px; overflow-x: auto; overflow-y: hidden; text-align: center; }
.pr-mathml { font-size: 1.04em; }
.pr-mathml-display { display: block; }
.pr-mathml-display .katex-display { margin: 0; }
.pr-math-src { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Consolas, monospace); font-size: 12px; color: var(--dsw-alias-state-warn-primary, #9a6700); white-space: pre-wrap; }
.pr-theorem {
  margin: 12px 0; padding: 9px 12px; border-radius: 8px;
  border-left: 3px solid var(--dsw-alias-brand-primary, #247bbf);
  background: var(--dsw-alias-bg-layer-2, #f6f8fa);
}
.pr-theorem-head { font-weight: 600; margin-bottom: 4px; }
.pr-theorem-head .pr-subtle { font-weight: 400; }
.pr-proof { margin: 10px 0; padding-left: 10px; border-left: 1px dashed var(--dsw-alias-border-l2, #d0d7de); color: var(--dsw-alias-label-secondary, #424a53); }
.pr-proof-label { font-style: italic; font-weight: 600; margin-right: 4px; }
.pr-page { margin: 18px 0 8px; font-size: 11px; color: var(--dsw-alias-label-secondary, #9aa4b2); border-top: 1px dashed var(--dsw-alias-border-l1, #eaeef2); padding-top: 6px; }
.pr-trans { margin: -4px 0 12px; padding: 7px 10px; border-radius: 7px; background: var(--dsw-alias-bg-layer-2, #f6f8fa); color: var(--dsw-alias-label-secondary, #424a53); font-size: 12.5px; line-height: 1.65; white-space: pre-wrap; }
.pr-empty { padding: 40px 24px; text-align: center; color: var(--dsw-alias-label-secondary, #57606a); font-size: 13px; }

.pr-notes-list { flex: 1; min-height: 0; overflow: auto; padding: 0 12px 16px; }
.pr-note { padding: 8px 0; border-top: 1px solid var(--dsw-alias-border-l1, #eaeef2); }
.pr-note:first-child { border-top: 0; }
.pr-note-head { font-size: 11px; color: var(--dsw-alias-label-secondary, #57606a); margin-bottom: 3px; }
.pr-note-quote { margin: 0 0 4px; padding-left: 8px; border-left: 2px solid var(--dsw-alias-border-l2, #d0d7de); color: var(--dsw-alias-label-secondary, #57606a); font-size: 12px; white-space: pre-wrap; }
.pr-note-body { font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
.pr-textarea {
  width: 100%; min-height: 92px; resize: vertical; padding: 7px 8px; border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-l1, #d0d7de); background: var(--dsw-alias-bg-base, #fff);
  color: inherit; font: inherit; line-height: 1.55; outline: none;
}
.pr-textarea:focus { border-color: var(--dsw-alias-brand-primary, #247bbf); }
.pr-editor { padding: 8px 12px 12px; border-top: 1px solid var(--dsw-alias-border-l1, #eaeef2); background: var(--dsw-alias-bg-layer-2, #f6f8fa); }
.pr-editor-actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 6px; }

.pr-selbar {
  position: fixed; z-index: 60; transform: translate(-50%, -100%);
  display: flex; align-items: center; gap: 2px; padding: 3px;
  border-radius: 9px; border: 1px solid var(--dsw-alias-border-l2, #d0d7de);
  background: var(--dsw-alias-bg-overlay, #fff);
  box-shadow: 0 6px 22px rgba(15, 23, 42, .16);
}
.pr-selbar .pr-btn { border-color: transparent; height: 24px; }
.pr-selbar .pr-btn:hover { background: var(--dsw-alias-bg-layer-2, #eef2f7); }

.pr-toast {
  position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 70;
  max-width: 520px; padding: 7px 13px; border-radius: 8px; font-size: 12.5px;
  background: var(--dsw-alias-bg-overlay, #fff); color: var(--dsw-alias-label-primary, #1f2328);
  border: 1px solid var(--dsw-alias-border-l2, #d0d7de);
  box-shadow: 0 6px 22px rgba(15, 23, 42, .16);
}
.pr-toast[data-kind="error"] { border-color: var(--dsw-alias-state-error-primary, #cf222e); color: var(--dsw-alias-state-error-primary, #cf222e); }

.pr-popover {
  position: fixed; z-index: 61; width: min(460px, 78vw); max-height: 46vh; overflow: auto;
  padding: 10px 12px; border-radius: 9px; font-size: 12.5px; line-height: 1.65;
  background: var(--dsw-alias-bg-overlay, #fff); border: 1px solid var(--dsw-alias-border-l2, #d0d7de);
  box-shadow: 0 8px 26px rgba(15, 23, 42, .18); white-space: pre-wrap;
}
.pr-popover-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.pr-popover-title { font-weight: 600; flex: 1; }

.pr-spinner { display: inline-block; width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid var(--dsw-alias-border-l2, #d0d7de); border-top-color: var(--dsw-alias-brand-primary, #247bbf);
  animation: pr-spin .8s linear infinite; }
@keyframes pr-spin { to { transform: rotate(360deg); } }
.pr-loading { display: flex; align-items: center; gap: 8px; padding: 24px; color: var(--dsw-alias-label-secondary, #57606a); }
.pr-error { margin: 12px 18px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-state-error-primary, #cf222e);
  color: var(--dsw-alias-state-error-primary, #cf222e); font-size: 12.5px; white-space: pre-wrap; }

@media (max-width: 1240px) {
  .pr-panel { grid-template-columns: 220px minmax(0, 1fr) 268px; }
  .pr-main { grid-template-columns: 168px minmax(0, 1fr); }
  .pr-pdf-hint { display: none; }
}
@media (max-width: 1040px) {
  .pr-panel { grid-template-columns: 210px minmax(0, 1fr) 0; }
  .pr-col-notes { display: none; }
}
@media (max-width: 820px) {
  .pr-panel { grid-template-columns: 0 minmax(0, 1fr) 0; }
  .pr-col-library { display: none; }
  .pr-main { grid-template-columns: 0 minmax(0, 1fr); }
  .pr-outline { display: none; }
}
`;
