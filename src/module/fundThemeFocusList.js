const { request } = require('../utils/index.js');
const fundMNSubjectList = require('./fundMNSubjectList');

async function getThemeFocusFallback() {
  const res = await fundMNSubjectList();
  const data = Array.isArray(res && res.Datas) ? res.Datas : [];

  return {
    data,
    fallback: true,
    message: '原主题焦点接口返回异常，已回退到基金主题列表',
  };
}

/**
 * 获取主题焦点列表
 */
module.exports = async (params = {}) => {
  const url =
    'https://h5.1234567.com.cn/AggregationStaticService/chooseCustomRouter/getFundThemeFocusAggr';
  const res = await request(url, params);

  if (!res || typeof res === 'string' || !Array.isArray(res.data)) {
    return getThemeFocusFallback();
  }

  return res;
};
