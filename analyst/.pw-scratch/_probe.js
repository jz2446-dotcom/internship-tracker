async (page) => {
  return await page.evaluate("({title: document.title, anchors: document.querySelectorAll('a[href]').length})");
}
