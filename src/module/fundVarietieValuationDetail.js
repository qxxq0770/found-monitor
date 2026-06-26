const { jsonp, request } = require('../utils/index.js');

function toFundGzValuation(data) {
  if (!data || !data.gsz) {
    return null;
  }

  const change = Number(data.gsz) - Number(data.dwjz);

  return {
    Datas: [],
    ErrCode: 0,
    Success: true,
    ErrMsg: null,
    Expansion: {
      FCODE: data.fundcode,
      SHORTNAME: data.name,
      GZTIME: data.gztime,
      GZ: data.gsz,
      GSZZL: data.gszzl,
      GZZF: Number.isFinite(change) ? change.toFixed(4) : '',
      JZRQ: data.jzrq,
      DWJZ: data.dwjz,
    },
  };
}

async function getFundGzValuation(fcode) {
  if (!fcode) {
    return null;
  }

  const data = await jsonp(
    `https://fundgz.1234567.com.cn/js/${fcode}.js`,
    'jsonpgz',
  );

  return toFundGzValuation(data);
}

/**
 * 获取基金净值估算（实时）
 */
module.exports = async (params = {}) => {
  const url =
    'https://fundcomapi.tiantianfunds.com/mm/fundTrade/FundValuationDetail';
  let appData = null;

  try {
    const res = await request(url, params);
    appData = res.data ? JSON.parse(res.data) : res.data;
  } catch (error) {
    appData = null;
  }

  if (appData && appData.Expansion && appData.Expansion.GZ) {
    return appData;
  }

  return (await getFundGzValuation(params.FCODE)) || appData;
};
