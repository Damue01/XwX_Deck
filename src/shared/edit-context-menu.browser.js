// Shared by the React shell and standalone Trace windows. Do not expose the
// WebView's Inspect/Reload/navigation menu in a desktop product.
(function () {
  if (typeof document === 'undefined' || document.documentElement.dataset.editMenuInstalled) return;
  document.documentElement.dataset.editMenuInstalled = 'true';
  var style = document.createElement('style');
  style.textContent = '.xwx-edit-menu{position:fixed;z-index:var(--z-menu,900);min-width:160px;padding:5px;border:1px solid var(--hairline,#e6e6e4);border-radius:9px;background:var(--surface,#fff);color:var(--ink,#17181a);box-shadow:var(--shadow-raise,0 12px 30px #0002);font:13px var(--sans,system-ui)}.xwx-edit-menu button{display:block;width:100%;border:0;border-radius:5px;padding:7px 10px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}.xwx-edit-menu button:hover,.xwx-edit-menu button:focus-visible{background:var(--hover,#f1f1ef);outline:none}';
  document.head.appendChild(style);
  var menu, restoreFocus;
  function close(restore) {
    if (menu) menu.remove();
    menu = null;
    if (restore && restoreFocus && restoreFocus.isConnected) restoreFocus.focus({preventScroll:true});
  }
  document.addEventListener('contextmenu', function (event) {
    if (event.defaultPrevented) return;
    event.preventDefault();
    close(false);
    var target = event.target instanceof Element ? event.target.closest('input,textarea,[contenteditable="true"]') : null;
    var input = target && /^(INPUT|TEXTAREA)$/.test(target.tagName);
    if (input && !/^(text|search|url|tel|email|password|number|textarea)$/.test(target.type)) target = null;
    input = target && /^(INPUT|TEXTAREA)$/.test(target.tagName);
    var editable = target && !target.disabled && !target.readOnly;
    var secret = target && target.type === 'password';
    var start = input ? target.selectionStart : null, end = input ? target.selectionEnd : null;
    var selection = window.getSelection();
    var range = selection && selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    var selected = input && start !== null ? target.value.slice(start,end) : String(selection || '');
    var originalValue = input ? target.value : null;
    var english = document.documentElement.lang.startsWith('en');
    var actions = [];
    function action(zh,en,run) { actions.push({label:english?en:zh,run:run}); }
    function restore() {
      if (target) target.focus({preventScroll:true});
      if (input && start !== null) target.setSelectionRange(start,end);
      else if (range && selection) { selection.removeAllRanges(); selection.addRange(range); }
    }
    async function copy() {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(selected);
      else { restore(); if (!document.execCommand('copy')) throw Error('copy'); }
    }
    function replace(value) {
      if (input && target.value !== originalValue) throw Error('input changed while clipboard was pending');
      restore();
      if (input && start !== null) {
        var next = target.value.slice(0,start) + value + target.value.slice(end);
        var proto = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto,'value').set.call(target,next);
        target.setSelectionRange(start+value.length,start+value.length);
        target.dispatchEvent(new Event('input',{bubbles:true}));
      } else if (!document.execCommand('insertText',false,value)) throw Error('paste');
    }
    if (selected && !secret) action('复制','Copy',copy);
    if (editable && selected && !secret) action('剪切','Cut',async function () { await copy(); replace(''); });
    if (editable) action('粘贴','Paste',async function () {
      if (navigator.clipboard && navigator.clipboard.readText) replace(await navigator.clipboard.readText());
      else { restore(); if (!document.execCommand('paste')) throw Error('paste'); }
    });
    if (target && !target.disabled) action('全选','Select all',function () {
      target.focus({preventScroll:true});
      if (input) target.select(); else { var all = document.createRange(); all.selectNodeContents(target); selection.removeAllRanges(); selection.addRange(all); }
    });
    if (!actions.length) return;
    restoreFocus = target || document.activeElement;
    menu = document.createElement('div');
    menu.className = 'xwx-edit-menu'; menu.setAttribute('role','menu'); menu.setAttribute('aria-label',english?'Edit':'编辑');
    actions.forEach(function (item) {
      var button = document.createElement('button'); button.type = 'button'; button.textContent = item.label; button.setAttribute('role','menuitem');
      button.addEventListener('click',function () {
        close(false);
        Promise.resolve().then(item.run).catch(function () {
          window.dispatchEvent(new CustomEvent('xwxdeck:clipboard-error',{detail:english?'Clipboard unavailable. Use keyboard shortcuts.':'剪贴板暂不可用，请使用键盘快捷键。'}));
        });
      }); menu.appendChild(button);
    });
    // Keep the menu inside the active modal's focus/inert boundary. A body
    // portal is hidden from assistive technology and focus-trapped by Base UI.
    var modal = event.target instanceof Element ? event.target.closest('[role="dialog"],[role="alertdialog"]') : null;
    (modal || document.body).appendChild(menu);
    menu.style.left = '0px'; menu.style.top = '0px';
    var rect = menu.getBoundingClientRect();
    var area = modal ? modal.getBoundingClientRect() : {left:0,top:0,right:window.innerWidth,bottom:window.innerHeight};
    menu.style.left = Math.max(area.left+8,Math.min(event.clientX,area.right-rect.width-8))-rect.left+'px';
    menu.style.top = Math.max(area.top+8,Math.min(event.clientY,area.bottom-rect.height-8))-rect.top+'px';
    menu.firstElementChild.focus({preventScroll:true});
  });
  document.addEventListener('pointerdown',function (event) { if (menu && !menu.contains(event.target)) close(false); },true);
  document.addEventListener('keydown',function (event) {
    if (!menu) return;
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation(); var buttons = Array.from(menu.children), index = buttons.indexOf(document.activeElement);
      buttons[(index+(event.key === 'ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();
    }
  },true);
  window.addEventListener('blur',function () { close(false); });
  window.addEventListener('resize',function () { close(false); });
  document.addEventListener('scroll',function () { close(false); },true);
})();
