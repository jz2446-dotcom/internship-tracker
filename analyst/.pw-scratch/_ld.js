async (page) => {
  return await page.evaluate(() => {
    const s = document.querySelectorAll('script[type="application/ld+json"]').length;
    const jp = [...document.querySelectorAll('script[type="application/ld+json"]')].map(x=>{try{return JSON.parse(x.textContent)}catch(e){return null}}).flat().find(o=>o&&o['@type']==='JobPosting');
    return {ldBlocks:s, title: jp&&jp.title, validThrough: jp&&jp.validThrough};
  });
}
