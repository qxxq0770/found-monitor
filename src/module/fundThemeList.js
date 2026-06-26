const { request } = require('../utils/index.js');
const fundMNSubjectList = require('./fundMNSubjectList');

async function getThemeFallback() {
  const res = await fundMNSubjectList();
  const data = Array.isArray(res && res.Datas) ? res.Datas : [];

  return {
    data,
    fallback: true,
    message: '原热门主题接口返回异常，已回退到基金主题列表',
  };
}

/**
 * 获取热门主题
 */
module.exports = async (params = {}) => {
  const url =
    'https://h5.1234567.com.cn/AggregationStaticService/getFundThemeListAggr';
  const res = await request(url, params);

  if (!res || typeof res === 'string' || !Array.isArray(res.data)) {
    return getThemeFallback();
  }

  return res;
};
