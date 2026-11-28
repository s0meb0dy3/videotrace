// 只负责在「总结 / 转写 / Agent」三个空页面之间切换。
const tabs = document.querySelectorAll(".tab");
const views = document.querySelectorAll(".view");

for (const tab of tabs) {
  tab.onclick = () => {
    for (const t of tabs) t.classList.toggle("active", t === tab);
    for (const v of views) v.hidden = v.id !== tab.dataset.view;
  };
}
