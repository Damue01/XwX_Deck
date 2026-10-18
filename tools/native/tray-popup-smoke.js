(async () => {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const items = [...document.querySelectorAll('[role="menuitem"]')];
  // Native window placement can briefly move an item beneath the real pointer.
  // Inspect the settled CSS state, including legitimate pointer hover.
  await Promise.allSettled(items.flatMap(item=>item.getAnimations()).map(animation=>animation.finished));
  const surface = document.querySelector('[role="menu"]');
  const state = await window.__TAURI__.core.invoke('pilot_tray', {action:'state'});
  const report = {
    items: items.map(button => ({label:button.textContent.trim(),disabled:button.disabled,rect:button.getBoundingClientRect().toJSON(),hit:button.contains(document.elementFromPoint(button.getBoundingClientRect().x+20,button.getBoundingClientRect().y+18))})),
    theme:document.documentElement.dataset.theme,language:document.documentElement.lang,
    background:getComputedStyle(surface).backgroundColor,font:getComputedStyle(items[0]).fontFamily,
    itemBackgrounds:items.map(item=>getComputedStyle(item).backgroundColor),menuFocused:document.activeElement===surface,
    itemHovered:items.map(item=>item.matches(':hover')),
    focused:document.activeElement?.textContent.trim(),stateKeys:Object.keys(state).sort(),
    managerMounted:!!document.querySelector('#page-signal'),viewport:{width:innerWidth,height:innerHeight}
  };
  await window.__TAURI__.core.invoke('pilot_tray',{action:'smoke-report',report});
})();
