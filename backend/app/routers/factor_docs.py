# -*- coding: utf-8 -*-
"""
因子文档 API

提供 Alpha158、Alpha101、Alpha191 因子名称、表达式、说明的查询接口
"""

from typing import Any, Dict, List

from fastapi import APIRouter

from app.schemas.schemas import ApiResponse

router = APIRouter(prefix="/api/factor-docs", tags=["Factor Docs"])


ALPHA101_FACTORS = [
    {"name": "alpha001", "expression": "(rank(Ts_ArgMax(SignedPower(((returns < 0) ? stddev(returns, 20) : close), 2.), 5)) -0.5)", "description": "基于收益率的波动性分析，当收益为负时使用波动率，否则使用收盘价，计算其平方的最大值位置排名。", "category": "动量"},
    {"name": "alpha002", "expression": "(-1 * correlation(rank(delta(log(volume), 2)), rank(((close - open) / open)), 6))", "description": "成交量变化与日内涨幅的相关性，负相关表示量价背离。", "category": "量价"},
    {"name": "alpha003", "expression": "(-1 * correlation(rank(open), rank(volume), 10))", "description": "开盘价与成交量的相关性排名，负相关表示高开低量或低开高量。", "category": "量价"},
    {"name": "alpha004", "expression": "(-1 * Ts_Rank(rank(low), 9))", "description": "最低价排名的时间序列排名，用于识别价格位置趋势。", "category": "位置"},
    {"name": "alpha005", "expression": "(rank((open - (sum(vwap, 10) / 10))) * (-1 * abs(rank((close - vwap)))))", "description": "开盘价与均价偏离度，结合收盘价与均价的偏离。", "category": "价格"},
    {"name": "alpha006", "expression": "(-1 * correlation(open, volume, 10))", "description": "开盘价与成交量的相关性，负相关表示开盘价高时成交量低。", "category": "量价"},
    {"name": "alpha007", "expression": "((adv20 < volume) ? ((-1 * ts_rank(abs(delta(close, 7)), 60)) * sign(delta(close, 7))) : (-1* 1))", "description": "成交量放大时，根据价格变化方向排名；否则返回-1。", "category": "量价"},
    {"name": "alpha008", "expression": "(-1 * rank(((sum(open, 5) * sum(returns, 5)) - delay((sum(open, 5) * sum(returns, 5)),10))))", "description": "开盘价与收益乘积的变化排名。", "category": "动量"},
    {"name": "alpha009", "expression": "((0 < ts_min(delta(close, 1), 5)) ? delta(close, 1) : ((ts_max(delta(close, 1), 5) < 0) ?delta(close, 1) : (-1 * delta(close, 1))))", "description": "根据近期价格变化趋势决定方向。", "category": "动量"},
    {"name": "alpha010", "expression": "rank(((0 < ts_min(delta(close, 1), 4)) ? delta(close, 1) : ((ts_max(delta(close, 1), 4) < 0)? delta(close, 1) : (-1 * delta(close, 1)))))", "description": "alpha009的排名版本。", "category": "动量"},
    {"name": "alpha011", "expression": "((rank(ts_max((vwap - close), 3)) + rank(ts_min((vwap - close), 3))) *rank(delta(volume, 3)))", "description": "均价与收盘价差异的极值排名，结合成交量变化。", "category": "量价"},
    {"name": "alpha012", "expression": "(sign(delta(volume, 1)) * (-1 * delta(close, 1)))", "description": "成交量变化方向与价格变化方向的交互。", "category": "量价"},
    {"name": "alpha013", "expression": "(-1 * rank(covariance(rank(close), rank(volume), 5)))", "description": "收盘价排名与成交量排名的协方差。", "category": "量价"},
    {"name": "alpha014", "expression": "((-1 * rank(delta(returns, 3))) * correlation(open, volume, 10))", "description": "收益变化排名与开盘量相关性的交互。", "category": "量价"},
    {"name": "alpha015", "expression": "(-1 * sum(rank(correlation(rank(high), rank(volume), 3)), 3))", "description": "最高价与成交量相关性的排名累加。", "category": "量价"},
    {"name": "alpha016", "expression": "(-1 * rank(covariance(rank(high), rank(volume), 5)))", "description": "最高价排名与成交量排名的协方差。", "category": "量价"},
    {"name": "alpha017", "expression": "(((-1 * rank(ts_rank(close, 10))) * rank(delta(delta(close, 1), 1))) *rank(ts_rank((volume / adv20), 5)))", "description": "收盘价时间排名、价格变化加速度、成交量相对排名的交互。", "category": "综合"},
    {"name": "alpha018", "expression": "(-1 * rank(((stddev(abs((close - open)), 5) + (close - open)) + correlation(close, open,10))))", "description": "日内波动、日内涨幅与开收相关性的综合排名。", "category": "综合"},
    {"name": "alpha019", "expression": "((-1 * sign(((close - delay(close, 7)) + delta(close, 7)))) * (1 + rank((1 + sum(returns,250)))))", "description": "周度价格变化方向与年度收益排名的交互。", "category": "动量"},
    {"name": "alpha020", "expression": "(((-1 * rank((open - delay(high, 1)))) * rank((open - delay(close, 1)))) * rank((open -delay(low, 1))))", "description": "开盘价相对昨日高低收位置的排名交互。", "category": "价格"},
    {"name": "alpha021", "expression": "(((((sum(close, 8) / 8) + stddev(close, 8)) < (sum(close, 2) / 2)) ? (-1 * 1) : (((sum(close,2) / 2) < ((sum(close, 8) / 8) - stddev(close, 8))) ? 1 : (((1 < (volume / adv20)) || ((volume /adv20) == 1)) ? 1 : (-1 * 1)))))", "description": "基于均线偏离和成交量的条件因子。", "category": "综合"},
    {"name": "alpha022", "expression": "(-1 * (delta(correlation(high, volume, 5), 5) * rank(stddev(close, 20))))", "description": "高价量相关性变化与收盘波动率的交互。", "category": "量价"},
    {"name": "alpha023", "expression": "(((sum(high, 20) / 20) < high) ? (-1 * delta(high, 2)) : 0)", "description": "当最高价高于20日均值时，返回高价变化的负值。", "category": "价格"},
    {"name": "alpha024", "expression": "((((delta((sum(close, 100) / 100), 100) / delay(close, 100)) < 0.05) ||((delta((sum(close, 100) / 100), 100) / delay(close, 100)) == 0.05)) ? (-1 * (close - ts_min(close,100))) : (-1 * delta(close, 3)))", "description": "长期均线变化较小时的反转因子。", "category": "趋势"},
    {"name": "alpha025", "expression": "rank(((((-1 * returns) * adv20) * vwap) * (high - close)))", "description": "收益、成交量、均价、日内波动的综合排名。", "category": "综合"},
    {"name": "alpha026", "expression": "(-1 * ts_max(correlation(ts_rank(volume, 5), ts_rank(high, 5), 5), 3))", "description": "成交量与最高价时间排名相关性的最大值。", "category": "量价"},
    {"name": "alpha027", "expression": "((0.5 < rank((sum(correlation(rank(volume), rank(vwap), 6), 2) / 2.0))) ? (-1 * 1) : 1)", "description": "成交量与均价排名相关性的条件因子。", "category": "量价"},
    {"name": "alpha028", "expression": "scale(((correlation(adv20, low, 5) + ((high + low) / 2)) - close))", "description": "成交量与最低价相关性、日内中点与收盘价的偏离。", "category": "量价"},
    {"name": "alpha029", "expression": "(min(product(rank(rank(scale(log(sum(ts_min(rank(rank((-1 * rank(delta((close - 1),5))))), 2), 1))))), 1), 5) + ts_rank(delay((-1 * returns), 6), 5))", "description": "复杂的价格变化排名与滞后收益时间排名的组合。", "category": "综合"},
    {"name": "alpha030", "expression": "(((1.0 - rank(((sign((close - delay(close, 1))) + sign((delay(close, 1) - delay(close, 2)))) +sign((delay(close, 2) - delay(close, 3)))))) * sum(volume, 5)) / sum(volume, 20))", "description": "连续价格变化方向与成交量的交互。", "category": "量价"},
    {"name": "alpha031", "expression": "((rank(rank(rank(decay_linear((-1 * rank(rank(delta(close, 10)))), 10)))) + rank((-1 *delta(close, 3)))) + sign(scale(correlation(adv20, low, 12))))", "description": "价格变化衰减排名、短期变化、量价相关性的综合。", "category": "综合"},
    {"name": "alpha032", "expression": "(scale(((sum(close, 7) / 7) - close)) + (20 * scale(correlation(vwap, delay(close, 5),230))))", "description": "短期价格偏离与长期均价相关性的组合。", "category": "趋势"},
    {"name": "alpha033", "expression": "rank((-1 * ((1 - (open / close))^1)))", "description": "开盘价与收盘价偏离的排名。", "category": "价格"},
    {"name": "alpha034", "expression": "rank(((1 - rank((stddev(returns, 2) / stddev(returns, 5)))) + (1 - rank(delta(close, 1)))))", "description": "收益波动比与价格变化的综合排名。", "category": "波动"},
    {"name": "alpha035", "expression": "((Ts_Rank(volume, 32) * (1 - Ts_Rank(((close + high) - low), 16))) * (1 -Ts_Rank(returns, 32)))", "description": "成交量、价格位置、收益的时间排名交互。", "category": "综合"},
    {"name": "alpha036", "expression": "(((((2.21 * rank(correlation((close - open), delay(volume, 1), 15))) + (0.7 * rank((open- close)))) + (0.73 * rank(Ts_Rank(delay((-1 * returns), 6), 5)))) + rank(abs(correlation(vwap,adv20, 6)))) + (0.6 * rank((((sum(close, 200) / 200) - open) * (close - open)))))", "description": "多因子加权组合。", "category": "综合"},
    {"name": "alpha037", "expression": "(rank(correlation(delay((open - close), 1), close, 200)) + rank((open - close)))", "description": "滞后日内涨幅与收盘价相关性排名。", "category": "量价"},
    {"name": "alpha038", "expression": "((-1 * rank(Ts_Rank(close, 10))) * rank((close / open)))", "description": "收盘价时间排名与日内涨幅的交互。", "category": "价格"},
    {"name": "alpha039", "expression": "((-1 * rank((delta(close, 7) * (1 - rank(decay_linear((volume / adv20), 9)))))) * (1 +rank(sum(returns, 250))))", "description": "周度价格变化与成交量衰减的综合。", "category": "综合"},
    {"name": "alpha040", "expression": "((-1 * rank(stddev(high, 10))) * correlation(high, volume, 10))", "description": "最高价波动与高价量相关性的交互。", "category": "量价"},
    {"name": "alpha041", "expression": "(((high * low)^0.5) - vwap)", "description": "高低价几何平均与均价的偏离。", "category": "价格"},
    {"name": "alpha042", "expression": "(rank((vwap - close)) / rank((vwap + close)))", "description": "均价与收盘价差异的相对排名。", "category": "价格"},
    {"name": "alpha043", "expression": "(ts_rank((volume / adv20), 20) * ts_rank((-1 * delta(close, 7)), 8))", "description": "相对成交量与价格变化的时间排名交互。", "category": "量价"},
    {"name": "alpha044", "expression": "(-1 * correlation(high, rank(volume), 5))", "description": "最高价与成交量排名的相关性。", "category": "量价"},
    {"name": "alpha045", "expression": "(-1 * ((rank((sum(delay(close, 5), 20) / 20)) * correlation(close, volume, 2)) *rank(correlation(sum(close, 5), sum(close, 20), 2))))", "description": "滞后收盘价均值、收盘量相关性、短期长期相关性的综合。", "category": "综合"},
    {"name": "alpha046", "expression": "((0.25 < (((delay(close, 20) - delay(close, 10)) / 10) - ((delay(close, 10) - close) / 10))) ?(-1 * 1) : (((((delay(close, 20) - delay(close, 10)) / 10) - ((delay(close, 10) - close) / 10)) < 0) ? 1 :((-1 * 1) * (close - delay(close, 1)))))", "description": "基于价格变化加速度的条件因子。", "category": "动量"},
    {"name": "alpha047", "expression": "((((rank((1 / close)) * volume) / adv20) * ((high * rank((high - close))) / (sum(high, 5) /5))) - rank((vwap - delay(vwap, 5))))", "description": "多因子组合，包括价格倒数、成交量、高价位置、均价变化。", "category": "综合"},
    {"name": "alpha049", "expression": "(((((delay(close, 20) - delay(close, 10)) / 10) - ((delay(close, 10) - close) / 10)) < (-1 *0.1)) ? 1 : ((-1 * 1) * (close - delay(close, 1))))", "description": "价格变化加速度的条件因子。", "category": "动量"},
    {"name": "alpha050", "expression": "(-1 * ts_max(rank(correlation(rank(volume), rank(vwap), 5)), 5))", "description": "成交量与均价排名相关性的最大排名。", "category": "量价"},
    {"name": "alpha051", "expression": "(((((delay(close, 20) - delay(close, 10)) / 10) - ((delay(close, 10) - close) / 10)) < (-1 *0.05)) ? 1 : ((-1 * 1) * (close - delay(close, 1))))", "description": "alpha049的变体，阈值不同。", "category": "动量"},
    {"name": "alpha052", "expression": "((((-1 * ts_min(low, 5)) + delay(ts_min(low, 5), 5)) * rank(((sum(returns, 240) -sum(returns, 20)) / 220))) * ts_rank(volume, 5))", "description": "最低价变化、长期收益差、成交量排名的综合。", "category": "综合"},
    {"name": "alpha053", "expression": "(-1 * delta((((close - low) - (high - close)) / (close - low)), 9))", "description": "价格在日内区间位置的变化。", "category": "价格"},
    {"name": "alpha054", "expression": "((-1 * ((low - close) * (open^5))) / ((low - high) * (close^5)))", "description": "低价收盘差与高价低价差的幂次比。", "category": "价格"},
    {"name": "alpha055", "expression": "(-1 * correlation(rank(((close - ts_min(low, 12)) / (ts_max(high, 12) - ts_min(low,12)))), rank(volume), 6))", "description": "价格相对位置与成交量的相关性。", "category": "量价"},
    {"name": "alpha057", "expression": "(0 - (1 * ((close - vwap) / decay_linear(rank(ts_argmax(close, 30)), 2))))", "description": "收盘价与均价偏离，除以收盘价最大值位置的衰减排名。", "category": "价格"},
    {"name": "alpha060", "expression": "(0 - (1 * ((2 * scale(rank(((((close - low) - (high - close)) / (high - low)) * volume)))) -scale(rank(ts_argmax(close, 10))))))", "description": "价格位置成交量与收盘最大位置的综合。", "category": "综合"},
    {"name": "alpha061", "expression": "(rank((vwap - ts_min(vwap, 16.1219))) < rank(correlation(vwap, adv180, 17.9282)))", "description": "均价与最低均价差、均价与长期成交量相关性的比较。", "category": "量价"},
    {"name": "alpha062", "expression": "((rank(correlation(vwap, sum(adv20, 22.4101), 9.91009)) < rank(((rank(open) +rank(open)) < (rank(((high + low) / 2)) + rank(high))))) * -1)", "description": "均价与成交量相关性、开盘价位置的综合条件。", "category": "综合"},
    {"name": "alpha064", "expression": "((rank(correlation(sum(((open * 0.178404) + (low * (1 - 0.178404))), 12.7054),sum(adv120, 12.7054), 16.6208)) < rank(delta(((((high + low) / 2) * 0.178404) + (vwap * (1 -0.178404))), 3.69741))) * -1)", "description": "加权价格与成交量相关性、加权价格变化的比较。", "category": "综合"},
    {"name": "alpha065", "expression": "((rank(correlation(((open * 0.00817205) + (vwap * (1 - 0.00817205))), sum(adv60,8.6911), 6.40374)) < rank((open - ts_min(open, 13.635)))) * -1)", "description": "开盘均价组合与成交量相关性、开盘价与最低开盘价差的比较。", "category": "综合"},
    {"name": "alpha066", "expression": "((rank(decay_linear(delta(vwap, 3.51013), 7.23052)) + Ts_Rank(decay_linear(((((low* 0.96633) + (low * (1 - 0.96633))) - vwap) / (open - ((high + low) / 2))), 11.4157), 6.72611)) * -1)", "description": "均价变化衰减、低价均价偏离衰减的综合。", "category": "综合"},
    {"name": "alpha068", "expression": "((Ts_Rank(correlation(rank(high), rank(adv15), 8.91644), 13.9333) <rank(delta(((close * 0.518371) + (low * (1 - 0.518371))), 1.06157))) * -1)", "description": "最高价与成交量排名相关性、加权价格变化的比较。", "category": "综合"},
    {"name": "alpha071", "expression": "max(Ts_Rank(decay_linear(correlation(Ts_Rank(close, 3.43976), Ts_Rank(adv180,12.0647), 18.0175), 4.20501), 15.6948), Ts_Rank(decay_linear((rank(((low + open) - (vwap +vwap)))^2), 16.4662), 4.4388))", "description": "两个复杂因子的最大值。", "category": "综合"},
    {"name": "alpha072", "expression": "(rank(decay_linear(correlation(((high + low) / 2), adv40, 8.93345), 10.1519)) /rank(decay_linear(correlation(Ts_Rank(vwap, 3.72469), Ts_Rank(volume, 18.5188), 6.86671),2.95011)))", "description": "日内中点与成交量相关性、均价与成交量时间排名相关性的比值。", "category": "量价"},
    {"name": "alpha073", "expression": "((max(rank(decay_linear(delta(vwap, 4.72775), 2.91864)),Ts_Rank(decay_linear(((delta(((open * 0.147155) + (low * (1 - 0.147155))), 2.03608) / ((open *0.147155) + (low * (1 - 0.147155)))) * -1), 3.33829), 16.7411)) * -1)", "description": "均价变化衰减、加权价格变化衰减的最大值。", "category": "综合"},
    {"name": "alpha074", "expression": "((rank(correlation(close, sum(adv30, 37.4843), 15.1365)) <rank(correlation(rank(((high * 0.0261661) + (vwap * (1 - 0.0261661)))), rank(volume), 11.4791)))* -1)", "description": "收盘价与成交量相关性、加权价格与成交量排名相关性的比较。", "category": "量价"},
    {"name": "alpha075", "expression": "(rank(correlation(vwap, volume, 4.24304)) < rank(correlation(rank(low), rank(adv50),12.4413)))", "description": "均价与成交量相关性、最低价与成交量排名相关性的比较。", "category": "量价"},
    {"name": "alpha077", "expression": "min(rank(decay_linear(((((high + low) / 2) + high) - (vwap + high)), 20.0451)),rank(decay_linear(correlation(((high + low) / 2), adv40, 3.1614), 5.64125)))", "description": "日内中点与高价差衰减、日内中点与成交量相关性衰减的最小值。", "category": "综合"},
    {"name": "alpha078", "expression": "(rank(correlation(sum(((low * 0.352233) + (vwap * (1 - 0.352233))), 19.7428),sum(adv40, 19.7428), 6.83313))^rank(correlation(rank(vwap), rank(volume), 5.77492)))", "description": "加权价格与成交量相关性、均价与成交量排名相关性的幂次组合。", "category": "量价"},
    {"name": "alpha081", "expression": "((rank(Log(product(rank((rank(correlation(vwap, sum(adv10, 49.6054),8.47743))^4)), 14.9655))) < rank(correlation(rank(vwap), rank(volume), 5.07914))) * -1)", "description": "均价与成交量相关性的复杂变换。", "category": "量价"},
    {"name": "alpha083", "expression": "((rank(delay(((high - low) / (sum(close, 5) / 5)), 2)) * rank(rank(volume))) / (((high -low) / (sum(close, 5) / 5)) / (vwap - close)))", "description": "日内波幅与均价、成交量的综合。", "category": "综合"},
    {"name": "alpha084", "expression": "SignedPower(Ts_Rank((vwap - ts_max(vwap, 15.3217)), 20.7127), delta(close,4.96796))", "description": "均价与最高均价差的时间排名，以价格变化为幂次。", "category": "价格"},
    {"name": "alpha085", "expression": "(rank(correlation(((high * 0.876703) + (close * (1 - 0.876703))), adv30,9.61331))^rank(correlation(Ts_Rank(((high + low) / 2), 3.70596), Ts_Rank(volume, 10.1595),7.11408)))", "description": "加权价格与成交量相关性、日内中点与成交量时间排名相关性的幂次组合。", "category": "量价"},
    {"name": "alpha086", "expression": "((Ts_Rank(correlation(close, sum(adv20, 14.7444), 6.00049), 20.4195) < rank(((open+ close) - (vwap + open)))) * -1)", "description": "收盘价与成交量相关性、开盘收盘与均价的比较。", "category": "量价"},
    {"name": "alpha088", "expression": "min(rank(decay_linear(((rank(open) + rank(low)) - (rank(high) + rank(close))),8.06882)), Ts_Rank(decay_linear(correlation(Ts_Rank(close, 8.44728), Ts_Rank(adv60,20.6966), 8.01266), 6.65053), 2.61957))", "description": "开盘低价排名与高价收盘排名差、收盘价与成交量时间排名相关性的最小值。", "category": "综合"},
    {"name": "alpha092", "expression": "min(Ts_Rank(decay_linear(((((high + low) / 2) + close) < (low + open)), 14.7221),18.8683), Ts_Rank(decay_linear(correlation(rank(low), rank(adv30), 7.58555), 6.94024),6.80584))", "description": "日内中点收盘与低价开盘比较、最低价与成交量排名相关性的最小值。", "category": "综合"},
    {"name": "alpha094", "expression": "((rank((vwap - ts_min(vwap, 11.5783)))^Ts_Rank(correlation(Ts_Rank(vwap,19.6462), Ts_Rank(adv60, 4.02992), 18.0926), 2.70756)) * -1)", "description": "均价与最低均价差的幂次，以均价与成交量时间排名相关性为幂底。", "category": "量价"},
    {"name": "alpha095", "expression": "(rank((open - ts_min(open, 12.4105))) < Ts_Rank((rank(correlation(sum(((high + low)/ 2), 19.1351), sum(adv40, 19.1351), 12.8742))^5), 11.7584))", "description": "开盘价与最低开盘价差、日内中点与成交量相关性幂次的比较。", "category": "量价"},
    {"name": "alpha096", "expression": "(max(Ts_Rank(decay_linear(correlation(rank(vwap), rank(volume), 3.83878),4.16783), 8.38151), Ts_Rank(decay_linear(Ts_ArgMax(correlation(Ts_Rank(close, 7.45404),Ts_Rank(adv60, 4.13242), 3.65459), 12.6556), 14.0365), 13.4143)) * -1)", "description": "均价与成交量排名相关性衰减、收盘价与成交量时间排名相关性最大位置衰减的最大值。", "category": "量价"},
    {"name": "alpha098", "expression": "(rank(decay_linear(correlation(vwap, sum(adv5, 26.4719), 4.58418), 7.18088)) -rank(decay_linear(Ts_Rank(Ts_ArgMin(correlation(rank(open), rank(adv15), 20.8187), 8.62571),6.95668), 8.07206)))", "description": "均价与成交量相关性衰减、开盘价与成交量排名相关性最小位置时间排名衰减的差。", "category": "量价"},
    {"name": "alpha099", "expression": "((rank(correlation(sum(((high + low) / 2), 19.8975), sum(adv60, 19.8975), 8.8136)) <rank(correlation(low, volume, 6.28259))) * -1)", "description": "日内中点与成交量相关性、最低价与成交量相关性的比较。", "category": "量价"},
    {"name": "alpha101", "expression": "((close - open) / ((high - low) + .001))", "description": "日内实体相对波幅，衡量K线实体占日内波幅的比例。", "category": "K线形态"},
]

ALPHA101_BASE_FUNCTIONS = [
    {"name": "returns", "syntax": "returns(df)", "description": "计算日收益率，使用2日滚动窗口。"},
    {"name": "ts_sum", "syntax": "ts_sum(df, window=10)", "description": "滚动求和，计算指定窗口内的累计值。"},
    {"name": "sma", "syntax": "sma(df, window=10)", "description": "简单移动平均，计算指定窗口内的均值。"},
    {"name": "stddev", "syntax": "stddev(df, window=10)", "description": "滚动标准差，衡量指定窗口内的波动性。"},
    {"name": "correlation", "syntax": "correlation(x, y, window=10)", "description": "滚动相关系数，计算两个序列在指定窗口内的相关性。"},
    {"name": "covariance", "syntax": "covariance(x, y, window=10)", "description": "滚动协方差，计算两个序列在指定窗口内的协方差。"},
    {"name": "ts_rank", "syntax": "ts_rank(df, window=10)", "description": "时间序列排名，返回当前值在窗口内的排名位置。"},
    {"name": "product", "syntax": "product(df, window=10)", "description": "滚动乘积，计算指定窗口内的累计乘积。"},
    {"name": "ts_min", "syntax": "ts_min(df, window=10)", "description": "滚动最小值，返回指定窗口内的最小值。"},
    {"name": "ts_max", "syntax": "ts_max(df, window=10)", "description": "滚动最大值，返回指定窗口内的最大值。"},
    {"name": "delta", "syntax": "delta(df, period=1)", "description": "差分，返回当前值与period期前的差值。"},
    {"name": "delay", "syntax": "delay(df, period=1)", "description": "滞后，返回period期前的值。"},
    {"name": "rank", "syntax": "rank(df)", "description": "截面排名，返回当前值在截面上的百分位排名。"},
    {"name": "scale", "syntax": "scale(df, k=1)", "description": "缩放，将数据缩放使得绝对值之和等于k。"},
    {"name": "ts_argmax", "syntax": "ts_argmax(df, window=10)", "description": "最大值位置，返回窗口内最大值出现的位置。"},
    {"name": "ts_argmin", "syntax": "ts_argmin(df, window=10)", "description": "最小值位置，返回窗口内最小值出现的位置。"},
    {"name": "decay_linear", "syntax": "decay_linear(df, period=10)", "description": "线性衰减移动平均，近期数据权重更高。"},
    {"name": "max", "syntax": "max(sr1, sr2)", "description": "逐元素最大值，返回两个序列对应位置的最大值。"},
    {"name": "min", "syntax": "min(sr1, sr2)", "description": "逐元素最小值，返回两个序列对应位置的最小值。"},
]


ALPHA191_FACTORS = [
    {"name": "alpha001", "expression": "(-1 * CORR(RANK(DELTA(LOG(VOLUME), 1)), RANK(((CLOSE - OPEN) / OPEN)), 6))", "description": "成交量对数变化与日内涨幅的相关性。", "category": "量价"},
    {"name": "alpha002", "expression": "-1 * DELTA((((CLOSE-LOW)-(HIGH-CLOSE))/(HIGH-LOW)), 1)", "description": "价格在日内区间位置的变化。", "category": "价格"},
    {"name": "alpha003", "expression": "SUM((CLOSE=DELAY(CLOSE,1)?0:CLOSE-(CLOSE>DELAY(CLOSE,1)?MIN(LOW,DELAY(CLOSE,1)):MAX(HIGH,DELAY(CLOSE,1)))),6)", "description": "基于价格变化的条件累加。", "category": "动量"},
    {"name": "alpha004", "expression": "((((SUM(CLOSE, 8) / 8) + STD(CLOSE, 8)) < (SUM(CLOSE, 2) / 2)) ? (-1 * 1) : (((SUM(CLOSE, 2) / 2) <((SUM(CLOSE, 8) / 8) - STD(CLOSE, 8))) ? 1 : (((1 < (VOLUME / MEAN(VOLUME,20))) || ((VOLUME /MEAN(VOLUME,20)) == 1)) ? 1 : (-1 * 1))))", "description": "基于均线偏离和成交量的条件因子。", "category": "综合"},
    {"name": "alpha005", "expression": "(-1 * TSMAX(CORR(TSRANK(VOLUME, 5), TSRANK(HIGH, 5), 5), 3))", "description": "成交量与最高价时间排名相关性的最大值。", "category": "量价"},
    {"name": "alpha006", "expression": "(RANK(SIGN(DELTA((((OPEN * 0.85) + (HIGH * 0.15))), 4)))* -1)", "description": "加权开盘高价变化的符号排名。", "category": "价格"},
    {"name": "alpha007", "expression": "((RANK(MAX((VWAP - CLOSE), 3)) + RANK(MIN((VWAP - CLOSE), 3))) * RANK(DELTA(VOLUME, 3)))", "description": "均价与收盘价差异的极值排名，结合成交量变化。", "category": "量价"},
    {"name": "alpha008", "expression": "RANK(DELTA(((((HIGH + LOW) / 2) * 0.2) + (VWAP * 0.8)), 4) * -1)", "description": "加权价格变化的排名。", "category": "价格"},
    {"name": "alpha009", "expression": "SMA(((HIGH+LOW)/2-(DELAY(HIGH,1)+DELAY(LOW,1))/2)*(HIGH-LOW)/VOLUME,7,2)", "description": "日内中点变化与波幅成交量的加权平均。", "category": "量价"},
    {"name": "alpha010", "expression": "(RANK(MAX(((RET < 0) ? STD(RET, 20) : CLOSE)^2),5))", "description": "收益为负时使用收益波动，否则使用收盘价的平方最大值排名。", "category": "波动"},
    {"name": "alpha011", "expression": "SUM(((CLOSE-LOW)-(HIGH-CLOSE))/(HIGH-LOW)*VOLUME,6)", "description": "价格位置与成交量的加权累加。", "category": "量价"},
    {"name": "alpha012", "expression": "(RANK((OPEN - (SUM(VWAP, 10) / 10)))) * (-1 * (RANK(ABS((CLOSE - VWAP)))))", "description": "开盘价与均价偏离、收盘价与均价偏离的综合。", "category": "价格"},
    {"name": "alpha013", "expression": "(((HIGH * LOW)^0.5) - VWAP)", "description": "高低价几何平均与均价的偏离。", "category": "价格"},
    {"name": "alpha014", "expression": "CLOSE-DELAY(CLOSE,5)", "description": "5日价格变化。", "category": "动量"},
    {"name": "alpha015", "expression": "OPEN/DELAY(CLOSE,1)-1", "description": "开盘价相对昨日收盘价的变化率。", "category": "价格"},
    {"name": "alpha016", "expression": "(-1 * TSMAX(RANK(CORR(RANK(VOLUME), RANK(VWAP), 5)), 5))", "description": "成交量与均价排名相关性的最大排名。", "category": "量价"},
    {"name": "alpha017", "expression": "RANK((VWAP - MAX(VWAP, 15)))^DELTA(CLOSE, 5)", "description": "均价与最高均价差的排名，以价格变化为幂次。", "category": "价格"},
    {"name": "alpha018", "expression": "CLOSE/DELAY(CLOSE,5)", "description": "5日价格比率。", "category": "动量"},
    {"name": "alpha019", "expression": "(CLOSE<DELAY(CLOSE,5)?(CLOSE-DELAY(CLOSE,5))/DELAY(CLOSE,5):(CLOSE=DELAY(CLOSE,5)?0:(CLOSE-DELAY(CLOSE,5))/CLOSE))", "description": "条件价格变化率。", "category": "动量"},
    {"name": "alpha020", "expression": "(CLOSE-DELAY(CLOSE,6))/DELAY(CLOSE,6)*100", "description": "6日价格变化百分比。", "category": "动量"},
    {"name": "alpha021", "expression": "REGBETA(MEAN(CLOSE,6),SEQUENCE(6))", "description": "6日均价的线性回归斜率。", "category": "趋势"},
    {"name": "alpha022", "expression": "SMA(((CLOSE-MEAN(CLOSE,6))/MEAN(CLOSE,6)-DELAY((CLOSE-MEAN(CLOSE,6))/MEAN(CLOSE,6),3)),12,1)", "description": "价格偏离均值的加权平均变化。", "category": "趋势"},
    {"name": "alpha023", "expression": "SMA((CLOSE>DELAY(CLOSE,1)?STD(CLOSE,20):0),20,1) / (SMA((CLOSE>DELAY(CLOSE,1)?STD(CLOSE,20):0),20,1) + SMA((CLOSE<=DELAY(CLOSE,1)?STD(CLOSE,20):0),20,1))*100", "description": "上涨时波动率占比。", "category": "波动"},
    {"name": "alpha024", "expression": "SMA(CLOSE-DELAY(CLOSE,5),5,1)", "description": "5日价格变化的加权平均。", "category": "动量"},
    {"name": "alpha025", "expression": "((-1 * RANK((DELTA(CLOSE, 7) * (1 - RANK(DECAYLINEAR((VOLUME / MEAN(VOLUME,20)), 9)))))) * (1 + RANK(SUM(RET, 250))))", "description": "周度价格变化与成交量衰减的综合。", "category": "综合"},
    {"name": "alpha026", "expression": "((((SUM(CLOSE, 7) / 7) - CLOSE)) + ((CORR(VWAP, DELAY(CLOSE, 5), 230))))", "description": "短期价格偏离与长期均价相关性的组合。", "category": "趋势"},
    {"name": "alpha027", "expression": "WMA((CLOSE-DELAY(CLOSE,3))/DELAY(CLOSE,3)*100+(CLOSE-DELAY(CLOSE,6))/DELAY(CLOSE,6)*100,12)", "description": "多期价格变化率的加权移动平均。", "category": "动量"},
    {"name": "alpha028", "expression": "3*SMA((CLOSE-TSMIN(LOW,9))/(TSMAX(HIGH,9)-TSMIN(LOW,9))*100,3,1)-2*SMA(SMA((CLOSE-TSMIN(LOW,9))/(MAX(HIGH,9)-TSMAX(LOW,9))*100,3,1),3,1)", "description": "类似KDJ指标的复杂计算。", "category": "位置"},
    {"name": "alpha029", "expression": "(CLOSE-DELAY(CLOSE,6))/DELAY(CLOSE,6)*VOLUME", "description": "价格变化率与成交量的乘积。", "category": "量价"},
    {"name": "alpha031", "expression": "(CLOSE-MEAN(CLOSE,12))/MEAN(CLOSE,12)*100", "description": "价格相对12日均值的偏离百分比。", "category": "趋势"},
    {"name": "alpha032", "expression": "(-1 * SUM(RANK(CORR(RANK(HIGH), RANK(VOLUME), 3)), 3))", "description": "最高价与成交量排名相关性的累加排名。", "category": "量价"},
    {"name": "alpha033", "expression": "((((-1 * TSMIN(LOW, 5)) + DELAY(TSMIN(LOW, 5), 5)) * RANK(((SUM(RET, 240) - SUM(RET, 20)) / 220))) *TSRANK(VOLUME, 5))", "description": "最低价变化、长期收益差、成交量排名的综合。", "category": "综合"},
    {"name": "alpha034", "expression": "MEAN(CLOSE,12)/CLOSE", "description": "12日均值与当前价格的比率。", "category": "趋势"},
    {"name": "alpha035", "expression": "(MIN(RANK(DECAYLINEAR(DELTA(OPEN, 1), 15)), RANK(DECAYLINEAR(CORR((VOLUME), ((OPEN * 0.65) +(OPEN *0.35)), 17),7))) * -1)", "description": "开盘价变化衰减、成交量与开盘价相关性衰减的最小值。", "category": "综合"},
    {"name": "alpha036", "expression": "RANK(SUM(CORR(RANK(VOLUME), RANK(VWAP),6), 2))", "description": "成交量与均价排名相关性的累加排名。", "category": "量价"},
    {"name": "alpha037", "expression": "(-1 * RANK(((SUM(OPEN, 5) * SUM(RET, 5)) - DELAY((SUM(OPEN, 5) * SUM(RET, 5)), 10))))", "description": "开盘价与收益乘积的变化排名。", "category": "动量"},
    {"name": "alpha038", "expression": "(((SUM(HIGH, 20) / 20) < HIGH) ? (-1 * DELTA(HIGH, 2)) : 0)", "description": "最高价高于20日均值时返回高价变化的负值。", "category": "价格"},
    {"name": "alpha039", "expression": "((RANK(DECAYLINEAR(DELTA((CLOSE), 2),8)) - RANK(DECAYLINEAR(CORR(((VWAP * 0.3) + (OPEN * 0.7)),SUM(MEAN(VOLUME,180), 37), 14), 12))) * -1)", "description": "价格变化衰减、加权价格与成交量相关性衰减的差。", "category": "综合"},
    {"name": "alpha040", "expression": "SUM((CLOSE>DELAY(CLOSE,1)?VOLUME:0),26)/SUM((CLOSE<=DELAY(CLOSE,1)?VOLUME:0),26)*100", "description": "上涨日成交量与下跌日成交量的比率。", "category": "量价"},
    {"name": "alpha041", "expression": "(RANK(MAX(DELTA((VWAP), 3), 5))* -1)", "description": "均价变化最大值的排名。", "category": "价格"},
    {"name": "alpha042", "expression": "((-1 * RANK(STD(HIGH, 10))) * CORR(HIGH, VOLUME, 10))", "description": "最高价波动与高价量相关性的交互。", "category": "量价"},
    {"name": "alpha043", "expression": "SUM((CLOSE>DELAY(CLOSE,1)?VOLUME:(CLOSE<DELAY(CLOSE,1)?-VOLUME:0)),6)", "description": "基于价格变化方向的成交量累加。", "category": "量价"},
    {"name": "alpha044", "expression": "(TSRANK(DECAYLINEAR(CORR(((LOW )), MEAN(VOLUME,10), 7), 6),4) + TSRANK(DECAYLINEAR(DELTA((VWAP),3), 10), 15))", "description": "最低价与成交量相关性衰减、均价变化衰减的时间排名和。", "category": "综合"},
    {"name": "alpha045", "expression": "(RANK(DELTA((((CLOSE * 0.6) + (OPEN *0.4))), 1)) * RANK(CORR(VWAP, MEAN(VOLUME,150), 15)))", "description": "加权价格变化与均价成交量相关性的交互。", "category": "量价"},
    {"name": "alpha046", "expression": "(MEAN(CLOSE,3)+MEAN(CLOSE,6)+MEAN(CLOSE,12)+MEAN(CLOSE,24))/(4*CLOSE)", "description": "多期均价与当前价格的比率。", "category": "趋势"},
    {"name": "alpha047", "expression": "SMA((TSMAX(HIGH,6)-CLOSE)/(TSMAX(HIGH,6)-TSMIN(LOW,6))*100,9,1)", "description": "价格在近期高低点区间的位置。", "category": "位置"},
    {"name": "alpha048", "expression": "(-1*((RANK(((SIGN((CLOSE - DELAY(CLOSE, 1))) + SIGN((DELAY(CLOSE, 1) - DELAY(CLOSE, 2)))) + SIGN((DELAY(CLOSE, 2) - DELAY(CLOSE, 3)))))) * SUM(VOLUME, 5)) / SUM(VOLUME, 20))", "description": "连续价格变化方向与成交量的交互。", "category": "量价"},
    {"name": "alpha049", "expression": "SUM(((HIGH+LOW)>=(DELAY(HIGH,1)+DELAY(LOW,1))?0:MAX(ABS(HIGH-DELAY(HIGH,1)),ABS(LOW-DELAY(LOW,1)))),12) / (SUM(((HIGH+LOW)>=(DELAY(HIGH,1)+DELAY(LOW,1))?0:MAX(ABS(HIGH-DELAY(HIGH,1)),ABS(LOW-DELAY(LOW,1)))),12) + SUM(((HIGH+LOW)<=(DELAY(HIGH,1)+DELAY(LOW,1))?0:MAX(ABS(HIGH-DELAY(HIGH,1)),ABS(LOW-DELAY(LOW,1)))),12))", "description": "高低价变化的复杂比率。", "category": "价格"},
    {"name": "alpha050", "expression": "SUM(((HIGH+LOW)<=(DELAY(HIGH,1)+DELAY(LOW,1))?0:MAX(ABS(HIGH-DELAY(HIGH,1)),ABS(LOW-DELAY(LOW,1)))),12)/(SUM(((HIGH+LOW)<=(DELAY(HIGH,1)+DELAY(LOW,1))?0:MAX(ABS(HIGH-DELAY(HIGH,1)),ABS(LOW-DELAY(LOW,1)))),12)+SUM(((HIGH+LOW)>=(DELAY(HIGH,1)+DELAY(LOW,1))?0:MAX(ABS(HIGH-DELAY(HIGH,1)),ABS(LOW-DELAY(LOW,1)))),12))-SUM(((HIGH+LOW)>=(DELAY(HIGH,1)+DELAY(LOW,1))?0:MAX(ABS(HIGH-DELAY(HIGH,1)),ABS(LOW-DELAY(LOW,1)))),12)/(SUM(((HIGH+LOW)>=(DELAY(HIGH,1)+DELAY(LOW,1))?0:MAX(ABS(HIGH-DELAY(HIGH,1)),ABS(LOW-DELAY(LOW,1)))),12)+SUM(((HIGH+LOW)<=(DELAY(HIGH,1)+DELAY(LOW,1))?0:MAX(ABS(HIGH-DELAY(HIGH,1)),ABS(LOW-DELAY(LOW,1)))),12))", "description": "高低价变化的差值比率。", "category": "价格"},
    {"name": "alpha051", "expression": "SUM(((HIGH+LOW)<=(DELAY(HIGH,1)+DELAY(LOW,1))?0:MAX(ABS(HIGH-DELAY(HIGH,1)),ABS(LOW-DELAY(LOW,1)))),12) / (SUM(((HIGH+LOW)<=(DELAY(HIGH,1)+DELAY(LOW,1))?0:MAX(ABS(HIGH-DELAY(HIGH,1)),ABS(LOW-DELAY(LOW,1)))),12)+SUM(((HIGH+LOW)>=(DELAY(HIGH,1)+DELAY(LOW,1))?0:MAX(ABS(HIGH-DELAY(HIGH,1)),ABS(LOW-DELAY(LOW,1)))),12))", "description": "高低价变化的比率。", "category": "价格"},
    {"name": "alpha052", "expression": "SUM(MAX(0,HIGH-DELAY((HIGH+LOW+CLOSE)/3,1)),26)/SUM(MAX(0,DELAY((HIGH+LOW+CLOSE)/3,1)-L),26)*100", "description": "高价与均价差、均价与低价差的比率。", "category": "价格"},
    {"name": "alpha053", "expression": "COUNT(CLOSE>DELAY(CLOSE,1),12)/12*100", "description": "12日内上涨天数占比。", "category": "统计"},
    {"name": "alpha054", "expression": "(-1 * RANK((STD(ABS(CLOSE - OPEN)) + (CLOSE - OPEN)) + CORR(CLOSE, OPEN,10)))", "description": "日内波动、日内涨幅与开收相关性的综合排名。", "category": "综合"},
    {"name": "alpha055", "expression": "SUM(16*(CLOSE-DELAY(CLOSE,1)+(CLOSE-OPEN)/2+DELAY(CLOSE,1)-DELAY(OPEN,1))/((ABS(HIGH-DELAY(CLOSE,1))>ABS(LOW-DELAY(CLOSE,1)) & ABS(HIGH-DELAY(CLOSE,1))>ABS(HIGH-DELAY(LOW,1))?ABS(HIGH-DELAY(CLOSE,1))+ABS(LOW-DELAY(CLOSE,1))/2 + ABS(DELAY(CLOSE,1)-DELAY(OPEN,1))/4:(ABS(LOW-DELAY(CLOSE,1))>ABS(HIGH-DELAY(LOW,1)) & ABS(LOW-DELAY(CLOSE,1))>ABS(HIGH-DELAY(CLOSE,1))?ABS(LOW-DELAY(CLOSE,1))+ABS(HIGH-DELAY(CLOSE,1))/2+ABS(DELAY(CLOSE,1)-DELAY(OPEN,1))/4:ABS(HIGH-DELAY(LOW,1))+ABS(DELAY(CLOSE,1)-DELAY(OPEN,1))/4)))*MAX(ABS(HIGH-DELAY(CLOSE,1)),ABS(LOW-DELAY(CLOSE,1))),20)", "description": "复杂的价格波动计算。", "category": "价格"},
    {"name": "alpha056", "expression": "(RANK((OPEN - TSMIN(OPEN, 12))) < RANK((RANK(CORR(SUM(((HIGH + LOW) / 2), 19),SUM(MEAN(VOLUME,40), 19), 13))^5)))", "description": "开盘价与最低开盘价差、日内中点与成交量相关性幂次的比较。", "category": "量价"},
    {"name": "alpha057", "expression": "SMA((CLOSE-TSMIN(LOW,9))/(TSMAX(HIGH,9)-TSMIN(LOW,9))*100,3,1)", "description": "价格在近期高低点区间的位置。", "category": "位置"},
    {"name": "alpha058", "expression": "COUNT(CLOSE>DELAY(CLOSE,1),20)/20*100", "description": "20日内上涨天数占比。", "category": "统计"},
    {"name": "alpha059", "expression": "SUM((CLOSE=DELAY(CLOSE,1)?0:CLOSE-(CLOSE>DELAY(CLOSE,1)?MIN(LOW,DELAY(CLOSE,1)):MAX(HIGH,DELAY(CLOSE,1)))),20)", "description": "基于价格变化的条件累加。", "category": "动量"},
    {"name": "alpha060", "expression": "SUM(((CLOSE-LOW)-(HIGH-CLOSE))/(HIGH-LOW)*VOLUME,20)", "description": "价格位置与成交量的加权累加。", "category": "量价"},
    {"name": "alpha061", "expression": "(MAX(RANK(DECAYLINEAR(DELTA(VWAP, 1), 12)),RANK(DECAYLINEAR(RANK(CORR((LOW),MEAN(VOLUME,80), 8)), 17))) * -1)", "description": "均价变化衰减、最低价与成交量相关性衰减的最大值。", "category": "综合"},
    {"name": "alpha062", "expression": "(-1 * CORR(HIGH, RANK(VOLUME), 5))", "description": "最高价与成交量排名的相关性。", "category": "量价"},
    {"name": "alpha063", "expression": "SMA(MAX(CLOSE-DELAY(CLOSE,1),0),6,1)/SMA(ABS(CLOSE-DELAY(CLOSE,1)),6,1)*100", "description": "类似RSI指标的计算。", "category": "动量"},
    {"name": "alpha064", "expression": "(MAX(RANK(DECAYLINEAR(CORR(RANK(VWAP), RANK(VOLUME), 4), 4)),RANK(DECAYLINEAR(MAX(CORR(RANK(CLOSE), RANK(MEAN(VOLUME,60)), 4), 13), 14))) * -1)", "description": "均价与成交量排名相关性衰减、收盘价与成交量排名相关性最大值衰减的最大值。", "category": "量价"},
    {"name": "alpha065", "expression": "MEAN(CLOSE,6)/CLOSE", "description": "6日均值与当前价格的比率。", "category": "趋势"},
    {"name": "alpha066", "expression": "(CLOSE-MEAN(CLOSE,6))/MEAN(CLOSE,6)*100", "description": "价格相对6日均值的偏离百分比。", "category": "趋势"},
    {"name": "alpha067", "expression": "SMA(MAX(CLOSE-DELAY(CLOSE,1),0),24,1)/SMA(ABS(CLOSE-DELAY(CLOSE,1)),24,1)*100", "description": "24日RSI类似指标。", "category": "动量"},
    {"name": "alpha068", "expression": "SMA(((HIGH+LOW)/2-(DELAY(HIGH,1)+DELAY(LOW,1))/2)*(HIGH-LOW)/VOLUME,15,2)", "description": "日内中点变化与波幅成交量的加权平均。", "category": "量价"},
    {"name": "alpha069", "expression": "(SUM(DTM,20)>SUM(DBM,20)?(SUM(DTM,20)-SUM(DBM,20))/SUM(DTM,20):(SUM(DTM,20)=SUM(DBM,20)?0:(SUM(DTM,20)-SUM(DBM,20))/SUM(DBM,20)))", "description": "基于开盘价变化的动量指标。", "category": "动量"},
    {"name": "alpha070", "expression": "STD(AMOUNT,6)", "description": "6日成交金额标准差。", "category": "成交量"},
    {"name": "alpha071", "expression": "(CLOSE-MEAN(CLOSE,24))/MEAN(CLOSE,24)*100", "description": "价格相对24日均值的偏离百分比。", "category": "趋势"},
    {"name": "alpha072", "expression": "SMA((TSMAX(HIGH,6)-CLOSE)/(TSMAX(HIGH,6)-TSMIN(LOW,6))*100,15,1)", "description": "价格在近期高低点区间的位置。", "category": "位置"},
    {"name": "alpha073", "expression": "((TSRANK(DECAYLINEAR(DECAYLINEAR(CORR((CLOSE), VOLUME, 10), 16), 4), 5) - RANK(DECAYLINEAR(CORR(VWAP, MEAN(VOLUME,30), 4),3))) * -1)", "description": "收盘价与成交量相关性衰减、均价与成交量相关性衰减的差。", "category": "量价"},
    {"name": "alpha074", "expression": "(RANK(CORR(SUM(((LOW * 0.35) + (VWAP * 0.65)), 20), SUM(MEAN(VOLUME,40), 20), 7)) + RANK(CORR(RANK(VWAP), RANK(VOLUME), 6)))", "description": "加权价格与成交量相关性、均价与成交量排名相关性的和。", "category": "量价"},
    {"name": "alpha075", "expression": "COUNT(CLOSE>OPEN & BANCHMARKINDEXCLOSE<BANCHMARKINDEXOPEN,50)/COUNT(BANCHMARKINDEXCLOSE<BANCHMARKINDEXOPEN,50)", "description": "大盘下跌时个股上涨的比率。", "category": "统计"},
    {"name": "alpha076", "expression": "STD(ABS((CLOSE/DELAY(CLOSE,1)-1))/VOLUME,20)/MEAN(ABS((CLOSE/DELAY(CLOSE,1)-1))/VOLUME,20)", "description": "价格变化率与成交量比值的波动性。", "category": "量价"},
    {"name": "alpha077", "expression": "MIN(RANK(DECAYLINEAR(((((HIGH + LOW) / 2) + HIGH) - (VWAP + HIGH)), 20)),RANK(DECAYLINEAR(CORR(((HIGH + LOW) / 2), MEAN(VOLUME,40), 3), 6)))", "description": "日内中点与高价差衰减、日内中点与成交量相关性衰减的最小值。", "category": "综合"},
    {"name": "alpha078", "expression": "((HIGH+LOW+CLOSE)/3-MA((HIGH+LOW+CLOSE)/3,12))/(0.015*MEAN(ABS(CLOSE-MEAN((HIGH+LOW+CLOSE)/3,12)),12))", "description": "类似CCI指标的计算。", "category": "位置"},
    {"name": "alpha079", "expression": "SMA(MAX(CLOSE-DELAY(CLOSE,1),0),12,1)/SMA(ABS(CLOSE-DELAY(CLOSE,1)),12,1)*100", "description": "12日RSI类似指标。", "category": "动量"},
    {"name": "alpha080", "expression": "(VOLUME-DELAY(VOLUME,5))/DELAY(VOLUME,5)*100", "description": "5日成交量变化百分比。", "category": "成交量"},
    {"name": "alpha081", "expression": "SMA(VOLUME,21,2)", "description": "成交量的加权移动平均。", "category": "成交量"},
    {"name": "alpha082", "expression": "SMA((TSMAX(HIGH,6)-CLOSE)/(TSMAX(HIGH,6)-TSMIN(LOW,6))*100,20,1)", "description": "价格在近期高低点区间的位置。", "category": "位置"},
    {"name": "alpha083", "expression": "(-1 * RANK(COVIANCE(RANK(HIGH), RANK(VOLUME), 5)))", "description": "最高价排名与成交量排名的协方差。", "category": "量价"},
    {"name": "alpha084", "expression": "SUM((CLOSE>DELAY(CLOSE,1)?VOLUME:(CLOSE<DELAY(CLOSE,1)?-VOLUME:0)),20)", "description": "基于价格变化方向的成交量累加。", "category": "量价"},
    {"name": "alpha085", "expression": "(TSRANK((VOLUME / MEAN(VOLUME,20)), 20) * TSRANK((-1 * DELTA(CLOSE, 7)), 8))", "description": "相对成交量与价格变化的时间排名交互。", "category": "量价"},
    {"name": "alpha086", "expression": "((0.25 < (((DELAY(CLOSE, 20) - DELAY(CLOSE, 10)) / 10) - ((DELAY(CLOSE, 10) - CLOSE) / 10))) ? (-1 * 1) :(((((DELAY(CLOSE, 20) - DELAY(CLOSE, 10)) / 10) - ((DELAY(CLOSE, 10) - CLOSE) / 10)) < 0) ?1 : ((-1 * 1) *(CLOSE - DELAY(CLOSE, 1)))))", "description": "基于价格变化加速度的条件因子。", "category": "动量"},
    {"name": "alpha087", "expression": "((RANK(DECAYLINEAR(DELTA(VWAP, 4), 7)) + TSRANK(DECAYLINEAR(((((LOW * 0.9) + (LOW * 0.1)) - VWAP) /(OPEN - ((HIGH + LOW) / 2))), 11), 7)) * -1)", "description": "均价变化衰减、低价均价偏离衰减的综合。", "category": "综合"},
    {"name": "alpha088", "expression": "(CLOSE-DELAY(CLOSE,20))/DELAY(CLOSE,20)*100", "description": "20日价格变化百分比。", "category": "动量"},
    {"name": "alpha089", "expression": "2*(SMA(CLOSE,13,2)-SMA(CLOSE,27,2)-SMA(SMA(CLOSE,13,2)-SMA(CLOSE,27,2),10,2))", "description": "类似MACD指标的计算。", "category": "趋势"},
    {"name": "alpha090", "expression": "(RANK(CORR(RANK(VWAP), RANK(VOLUME), 5)) * -1)", "description": "均价与成交量排名相关性的负值。", "category": "量价"},
    {"name": "alpha091", "expression": "((RANK((CLOSE - MAX(CLOSE, 5)))*RANK(CORR((MEAN(VOLUME,40)), LOW, 5))) * -1)", "description": "价格与最高价差、成交量与最低价相关性的交互。", "category": "量价"},
    {"name": "alpha092", "expression": "(MAX(RANK(DECAYLINEAR(DELTA(((CLOSE * 0.35) + (VWAP *0.65)), 2), 3)),TSRANK(DECAYLINEAR(ABS(CORR((MEAN(VOLUME,180)), CLOSE, 13)), 5), 15)) * -1)", "description": "加权价格变化衰减、成交量与收盘价相关性衰减的最大值。", "category": "综合"},
    {"name": "alpha093", "expression": "SUM((OPEN>=DELAY(OPEN,1)?0:MAX((OPEN-LOW),(OPEN-DELAY(OPEN,1)))),20)", "description": "开盘价下跌时的开盘价与低价差累加。", "category": "价格"},
    {"name": "alpha094", "expression": "SUM((CLOSE>DELAY(CLOSE,1)?VOLUME:(CLOSE<DELAY(CLOSE,1)?-VOLUME:0)),30)", "description": "基于价格变化方向的成交量累加。", "category": "量价"},
    {"name": "alpha095", "expression": "STD(AMOUNT,20)", "description": "20日成交金额标准差。", "category": "成交量"},
    {"name": "alpha096", "expression": "SMA(SMA((CLOSE-TSMIN(LOW,9))/(TSMAX(HIGH,9)-TSMIN(LOW,9))*100,3,1),3,1)", "description": "价格在近期高低点区间的位置的平滑。", "category": "位置"},
    {"name": "alpha097", "expression": "STD(VOLUME,10)", "description": "10日成交量标准差。", "category": "成交量"},
    {"name": "alpha098", "expression": "((((DELTA((SUM(CLOSE, 100) / 100), 100) / DELAY(CLOSE, 100)) < 0.05) || ((DELTA((SUM(CLOSE, 100) / 100), 100) /DELAY(CLOSE, 100)) == 0.05)) ? (-1 * (CLOSE - TSMIN(CLOSE, 100))) : (-1 * DELTA(CLOSE, 3)))", "description": "长期均线变化较小时的反转因子。", "category": "趋势"},
    {"name": "alpha099", "expression": "(-1 * Rank(Cov(Rank(CLOSE), Rank(VOLUME), 5)))", "description": "收盘价排名与成交量排名的协方差。", "category": "量价"},
    {"name": "alpha100", "expression": "STD(VOLUME,20)", "description": "20日成交量标准差。", "category": "成交量"},
    {"name": "alpha101", "expression": "((RANK(CORR(CLOSE, SUM(MEAN(VOLUME,30), 37), 15)) < RANK(CORR(RANK(((HIGH * 0.1) + (VWAP * 0.9))),RANK(VOLUME), 11))) * -1)", "description": "收盘价与成交量相关性、加权价格与成交量排名相关性的比较。", "category": "量价"},
    {"name": "alpha102", "expression": "SMA(MAX(VOLUME-DELAY(VOLUME,1),0),6,1)/SMA(ABS(VOLUME-DELAY(VOLUME,1)),6,1)*100", "description": "成交量RSI类似指标。", "category": "成交量"},
    {"name": "alpha103", "expression": "((20-LOWDAY(LOW,20))/20)*100", "description": "距离最低价天数比例。", "category": "时间"},
    {"name": "alpha104", "expression": "(-1 * (DELTA(CORR(HIGH, VOLUME, 5), 5) * RANK(STD(CLOSE, 20))))", "description": "高价量相关性变化与收盘波动率的交互。", "category": "量价"},
    {"name": "alpha105", "expression": "(-1 * CORR(RANK(OPEN), RANK(VOLUME), 10))", "description": "开盘价排名与成交量排名的相关性。", "category": "量价"},
    {"name": "alpha106", "expression": "CLOSE-DELAY(CLOSE,20)", "description": "20日价格变化。", "category": "动量"},
    {"name": "alpha107", "expression": "(((-1 * RANK((OPEN - DELAY(HIGH, 1)))) * RANK((OPEN - DELAY(CLOSE, 1)))) * RANK((OPEN - DELAY(LOW, 1))))", "description": "开盘价相对昨日高低收位置的排名交互。", "category": "价格"},
    {"name": "alpha108", "expression": "((RANK((HIGH - MIN(HIGH, 2)))^RANK(CORR((VWAP), (MEAN(VOLUME,120)), 6))) * -1)", "description": "最高价与最低高价差的排名，以均价与成交量相关性为幂次。", "category": "量价"},
    {"name": "alpha109", "expression": "SMA(HIGH-LOW,10,2)/SMA(SMA(HIGH-LOW,10,2),10,2)", "description": "日内波幅的平滑比率。", "category": "波动"},
    {"name": "alpha110", "expression": "SUM(MAX(0,HIGH-DELAY(CLOSE,1)),20)/SUM(MAX(0,DELAY(CLOSE,1)-LOW),20)*100", "description": "高价与收盘价差、收盘价与低价差的比率。", "category": "价格"},
    {"name": "alpha111", "expression": "SMA(VOL*((CLOSE-LOW)-(HIGH-CLOSE))/(HIGH-LOW),11,2)-SMA(VOL*((CLOSE-LOW)-(HIGH-CLOSE))/(HIGH-LOW),4,2)", "description": "价格位置与成交量加权平均的差。", "category": "量价"},
    {"name": "alpha112", "expression": "(SUM((CLOSE-DELAY(CLOSE,1)>0? CLOSE-DELAY(CLOSE,1):0),12) - SUM((CLOSE-DELAY(CLOSE,1)<0?ABS(CLOSE-DELAY(CLOSE,1)):0),12))/(SUM((CLOSE-DELAY(CLOSE,1)>0?CLOSE-DELAY(CLOSE,1):0),12) + SUM((CLOSE-DELAY(CLOSE,1)<0?ABS(CLOSE-DELAY(CLOSE,1)):0),12))*100", "description": "上涨下跌幅度差的比率。", "category": "动量"},
    {"name": "alpha113", "expression": "(-1 * ((RANK((SUM(DELAY(CLOSE, 5), 20) / 20)) * CORR(CLOSE, VOLUME, 2)) * RANK(CORR(SUM(CLOSE, 5),SUM(CLOSE, 20), 2))))", "description": "滞后收盘价均值、收盘量相关性、短期长期相关性的综合。", "category": "综合"},
    {"name": "alpha114", "expression": "((RANK(DELAY(((HIGH - LOW) / (SUM(CLOSE, 5) / 5)), 2)) * RANK(RANK(VOLUME))) / (((HIGH - LOW) /(SUM(CLOSE, 5) / 5)) / (VWAP - CLOSE)))", "description": "日内波幅与均价、成交量的综合。", "category": "综合"},
    {"name": "alpha115", "expression": "(RANK(CORR(((HIGH * 0.9) + (CLOSE * 0.1)), MEAN(VOLUME,30), 10))^RANK(CORR(TSRANK(((HIGH + LOW) /2), 4), TSRANK(VOLUME, 10), 7)))", "description": "加权价格与成交量相关性、日内中点与成交量时间排名相关性的幂次组合。", "category": "量价"},
    {"name": "alpha116", "expression": "REGBETA(CLOSE,SEQUENCE,20)", "description": "20日收盘价的线性回归斜率。", "category": "趋势"},
    {"name": "alpha117", "expression": "((TSRANK(VOLUME, 32) * (1 - TSRANK(((CLOSE + HIGH) - LOW), 16))) * (1 - TSRANK(RET, 32)))", "description": "成交量、价格位置、收益的时间排名交互。", "category": "综合"},
    {"name": "alpha118", "expression": "SUM(HIGH-OPEN,20)/SUM(OPEN-LOW,20)*100", "description": "高价开盘差与开盘低价差的比率。", "category": "价格"},
    {"name": "alpha119", "expression": "(RANK(DECAYLINEAR(CORR(VWAP, SUM(MEAN(VOLUME,5), 26), 5), 7)) - RANK(DECAYLINEAR(TSRANK(MIN(CORR(RANK(OPEN), RANK(MEAN(VOLUME,15)), 21), 9), 7), 8)))", "description": "均价与成交量相关性衰减、开盘价与成交量排名相关性最小值时间排名衰减的差。", "category": "量价"},
    {"name": "alpha120", "expression": "(RANK((VWAP - CLOSE)) / RANK((VWAP + CLOSE)))", "description": "均价与收盘价差异的相对排名。", "category": "价格"},
    {"name": "alpha121", "expression": "((RANK((VWAP - MIN(VWAP, 12)))^TSRANK(CORR(TSRANK(VWAP, 20), TSRANK(MEAN(VOLUME,60), 2), 18), 3)) *-1)", "description": "均价与最低均价差的幂次，以均价与成交量时间排名相关性为幂底。", "category": "量价"},
    {"name": "alpha122", "expression": "(SMA(SMA(SMA(LOG(CLOSE),13,2),13,2),13,2)-DELAY(SMA(SMA(SMA(LOG(CLOSE),13,2),13,2),13,2),1))/DELAY(SMA(SMA(SMA(LOG(CLOSE),13,2),13,2),13,2),1)", "description": "收盘价对数的三重平滑变化率。", "category": "趋势"},
    {"name": "alpha123", "expression": "((RANK(CORR(SUM(((HIGH + LOW) / 2), 20), SUM(MEAN(VOLUME,60), 20), 9)) < RANK(CORR(LOW, VOLUME,6))) * -1)", "description": "日内中点与成交量相关性、最低价与成交量相关性的比较。", "category": "量价"},
    {"name": "alpha124", "expression": "(CLOSE - VWAP) / DECAYLINEAR(RANK(TSMAX(CLOSE, 30)),2)", "description": "收盘价与均价偏离，除以收盘价最大值排名的衰减。", "category": "价格"},
    {"name": "alpha125", "expression": "(RANK(DECAYLINEAR(CORR((VWAP), MEAN(VOLUME,80),17), 20)) / RANK(DECAYLINEAR(DELTA(((CLOSE * 0.5) + (VWAP * 0.5)), 3), 16)))", "description": "均价与成交量相关性衰减、加权价格变化衰减的比值。", "category": "量价"},
    {"name": "alpha126", "expression": "(CLOSE+HIGH+LOW)/3", "description": "典型价格（最高价、最低价、收盘价的平均值）。", "category": "价格"},
    {"name": "alpha127", "expression": "(MEAN((100*(CLOSE-MAX(CLOSE,12))/(MAX(CLOSE,12)))^2),12)^(1/2)", "description": "价格相对最高价的偏离波动。", "category": "波动"},
    {"name": "alpha128", "expression": "100-(100/(1+SUM(((HIGH+LOW+CLOSE)/3>DELAY((HIGH+LOW+CLOSE)/3,1)?(HIGH+LOW+CLOSE)/3*VOLUME:0),14)/SUM(((HIGH+LOW+CLOSE)/3<DELAY((HIGH+LOW+CLOSE)/3,1)?(HIGH+LOW+CLOSE)/3*VOLUME:0),14)))", "description": "类似MFI指标的计算。", "category": "量价"},
    {"name": "alpha129", "expression": "SUM((CLOSE-DELAY(CLOSE,1)<0?ABS(CLOSE-DELAY(CLOSE,1)):0),12)", "description": "12日下跌幅度累加。", "category": "动量"},
    {"name": "alpha130", "expression": "(RANK(DECAYLINEAR(CORR(((HIGH + LOW) / 2), MEAN(VOLUME,40), 9), 10)) / RANK(DECAYLINEAR(CORR(RANK(VWAP), RANK(VOLUME), 7),3)))", "description": "日内中点与成交量相关性衰减、均价与成交量排名相关性衰减的比值。", "category": "量价"},
    {"name": "alpha131", "expression": "(RANK(DELAT(VWAP, 1))^TSRANK(CORR(CLOSE,MEAN(VOLUME,50), 18), 18))", "description": "均价变化的排名，以收盘价与成交量相关性为幂次。", "category": "量价"},
    {"name": "alpha132", "expression": "MEAN(AMOUNT,20)", "description": "20日平均成交金额。", "category": "成交量"},
    {"name": "alpha133", "expression": "((20-HIGHDAY(HIGH,20))/20)*100-((20-LOWDAY(LOW,20))/20)*100", "description": "距离最高价与最低价天数差的百分比。", "category": "时间"},
    {"name": "alpha134", "expression": "(CLOSE-DELAY(CLOSE,12))/DELAY(CLOSE,12)*VOLUME", "description": "价格变化率与成交量的乘积。", "category": "量价"},
    {"name": "alpha135", "expression": "SMA(DELAY(CLOSE/DELAY(CLOSE,20),1),20,1)", "description": "20日价格变化率的滞后加权平均。", "category": "动量"},
    {"name": "alpha136", "expression": "((-1 * RANK(DELTA(RET, 3))) * CORR(OPEN, VOLUME, 10))", "description": "收益变化排名与开盘量相关性的交互。", "category": "量价"},
    {"name": "alpha137", "expression": "16*(CLOSE-DELAY(CLOSE,1)+(CLOSE-OPEN)/2+DELAY(CLOSE,1)-DELAY(OPEN,1))/((ABS(HIGH-DELAY(CLOSE,1))>ABS(LOW-DELAY(CLOSE,1)) & ABS(HIGH-DELAY(CLOSE,1))>ABS(HIGH-DELAY(LOW,1))?ABS(HIGH-DELAY(CLOSE,1))+ABS(LOW-DELAY(CLOSE,1))/2+ABS(DELAY(CLOSE,1)-DELAY(OPEN,1))/4:(ABS(LOW-DELAY(CLOSE,1))>ABS(HIGH-DELAY(LOW,1)) & ABS(LOW-DELAY(CLOSE,1))>ABS(HIGH-DELAY(CLOSE,1))?ABS(LOW-DELAY(CLOSE,1))+ABS(HIGH-DELAY(CLOSE,1))/2+ABS(DELAY(CLOSE,1)-DELAY(OPEN,1))/4:ABS(HIGH-DELAY(LOW,1))+ABS(DELAY(CLOSE,1)-DELAY(OPEN,1))/4)))*MAX(ABS(HIGH-DELAY(CLOSE,1)),ABS(LOW-DELAY(CLOSE,1)))", "description": "复杂的价格波动计算。", "category": "价格"},
    {"name": "alpha138", "expression": "((RANK(DECAYLINEAR(DELTA((((LOW * 0.7) + (VWAP *0.3))), 3), 20)) - TSRANK(DECAYLINEAR(TSRANK(CORR(TSRANK(LOW, 8), TSRANK(MEAN(VOLUME,60), 17), 5), 19), 16), 7)) * -1)", "description": "加权价格变化衰减、最低价与成交量时间排名相关性衰减的差。", "category": "综合"},
    {"name": "alpha139", "expression": "(-1 * CORR(OPEN, VOLUME, 10))", "description": "开盘价与成交量的相关性。", "category": "量价"},
    {"name": "alpha140", "expression": "MIN(RANK(DECAYLINEAR(((RANK(OPEN) + RANK(LOW)) - (RANK(HIGH) + RANK(CLOSE))), 8)), TSRANK(DECAYLINEAR(CORR(TSRANK(CLOSE, 8), TSRANK(MEAN(VOLUME,60), 20), 8), 7), 3))", "description": "开盘低价排名与高价收盘排名差、收盘价与成交量时间排名相关性的最小值。", "category": "综合"},
    {"name": "alpha141", "expression": "(RANK(CORR(RANK(HIGH), RANK(MEAN(VOLUME,15)), 9))* -1)", "description": "最高价排名与成交量均值排名的相关性。", "category": "量价"},
    {"name": "alpha142", "expression": "(((-1 * RANK(TSRANK(CLOSE, 10))) * RANK(DELTA(DELTA(CLOSE, 1), 1))) * RANK(TSRANK((VOLUME/MEAN(VOLUME,20)), 5)))", "description": "收盘价时间排名、价格变化加速度、相对成交量排名的交互。", "category": "综合"},
    {"name": "alpha144", "expression": "SUMIF(ABS(CLOSE/DELAY(CLOSE,1)-1)/AMOUNT,20,CLOSE<DELAY(CLOSE,1))/COUNT(CLOSE<DELAY(CLOSE,1),20)", "description": "下跌时价格变化率与成交金额比值的均值。", "category": "量价"},
    {"name": "alpha145", "expression": "(MEAN(VOLUME,9)-MEAN(VOLUME,26))/MEAN(VOLUME,12)*100", "description": "成交量均值的差值比率。", "category": "成交量"},
    {"name": "alpha146", "expression": "MEAN((CLOSE-DELAY(CLOSE,1))/DELAY(CLOSE,1)-SMA((CLOSE-DELAY(CLOSE,1))/DELAY(CLOSE,1),61,2),20)*((CLOSE-DELAY(CLOSE,1))/DELAY(CLOSE,1)-SMA((CLOSE-DELAY(CLOSE,1))/DELAY(CLOSE,1),61,2))/SMA(((CLOSE-DELAY(CLOSE,1))/DELAY(CLOSE,1)-((CLOSE-DELAY(CLOSE,1))/DELAY(CLOSE,1)-SMA((CLOSE-DELAY(CLOSE,1))/DELAY(CLOSE,1),61,2)))^2,61,2)", "description": "价格变化率的复杂统计计算。", "category": "统计"},
    {"name": "alpha147", "expression": "REGBETA(MEAN(CLOSE,12),SEQUENCE(12))", "description": "12日均价的线性回归斜率。", "category": "趋势"},
    {"name": "alpha148", "expression": "((RANK(CORR((OPEN), SUM(MEAN(VOLUME,60), 9), 6)) < RANK((OPEN - TSMIN(OPEN, 14)))) * -1)", "description": "开盘价与成交量相关性、开盘价与最低开盘价差的比较。", "category": "量价"},
    {"name": "alpha150", "expression": "(CLOSE+HIGH+LOW)/3*VOLUME", "description": "典型价格与成交量的乘积。", "category": "量价"},
    {"name": "alpha151", "expression": "SMA(CLOSE-DELAY(CLOSE,20),20,1)", "description": "20日价格变化的加权平均。", "category": "动量"},
    {"name": "alpha152", "expression": "SMA(MEAN(DELAY(SMA(DELAY(CLOSE/DELAY(CLOSE,9),1),9,1),1),12)-MEAN(DELAY(SMA(DELAY(CLOSE/DELAY(CLOSE,9),1),9,1),1),26),9,1)", "description": "类似MACD的复杂计算。", "category": "趋势"},
    {"name": "alpha153", "expression": "(MEAN(CLOSE,3)+MEAN(CLOSE,6)+MEAN(CLOSE,12)+MEAN(CLOSE,24))/4", "description": "多期均价的平均。", "category": "趋势"},
    {"name": "alpha154", "expression": "(((VWAP - MIN(VWAP, 16))) < (CORR(VWAP, MEAN(VOLUME,180), 18)))", "description": "均价与最低均价差、均价与成交量相关性的比较。", "category": "量价"},
    {"name": "alpha155", "expression": "SMA(VOLUME,13,2)-SMA(VOLUME,27,2)-SMA(SMA(VOLUME,13,2)-SMA(VOLUME,27,2),10,2)", "description": "成交量MACD类似指标。", "category": "成交量"},
    {"name": "alpha156", "expression": "(MAX(RANK(DECAYLINEAR(DELTA(VWAP, 5), 3)), RANK(DECAYLINEAR(((DELTA(((OPEN * 0.15) + (LOW *0.85)),2) / ((OPEN * 0.15) + (LOW * 0.85))) * -1), 3))) * -1)", "description": "均价变化衰减、加权价格变化衰减的最大值。", "category": "综合"},
    {"name": "alpha157", "expression": "(MIN(PROD(RANK(RANK(LOG(SUM(TSMIN(RANK(RANK((-1 * RANK(DELTA((CLOSE - 1), 5))))), 2), 1)))), 1), 5) + TSRANK(DELAY((-1 * RET), 6), 5))", "description": "复杂的价格变化排名与滞后收益时间排名的组合。", "category": "综合"},
    {"name": "alpha158", "expression": "((HIGH-SMA(CLOSE,15,2))-(LOW-SMA(CLOSE,15,2)))/CLOSE", "description": "高低价与均价差的比率。", "category": "价格"},
    {"name": "alpha159", "expression": "((CLOSE-SUM(MIN(LOW,DELAY(CLOSE,1)),6))/SUM(MAX(HGIH,DELAY(CLOSE,1))-MIN(LOW,DELAY(CLOSE,1)),6)*12*24+(CLOSE-SUM(MIN(LOW,DELAY(CLOSE,1)),12))/SUM(MAX(HGIH,DELAY(CLOSE,1))-MIN(LOW,DELAY(CLOSE,1)),12)*6*24+(CLOSE-SUM(MIN(LOW,DELAY(CLOSE,1)),24))/SUM(MAX(HGIH,DELAY(CLOSE,1))-MIN(LOW,DELAY(CLOSE,1)),24)*6*24)*100/(6*12+6*24+12*24)", "description": "多期价格位置的加权平均。", "category": "位置"},
    {"name": "alpha160", "expression": "SMA((CLOSE<=DELAY(CLOSE,1)?STD(CLOSE,20):0),20,1)", "description": "下跌时波动率的加权平均。", "category": "波动"},
    {"name": "alpha161", "expression": "MEAN(MAX(MAX((HIGH-LOW),ABS(DELAY(CLOSE,1)-HIGH)),ABS(DELAY(CLOSE,1)-LOW)),12)", "description": "12日最大波动的平均。", "category": "波动"},
    {"name": "alpha162", "expression": "(SMA(MAX(CLOSE-DELAY(CLOSE,1),0),12,1)/SMA(ABS(CLOSE-DELAY(CLOSE,1)),12,1)*100-MIN(SMA(MAX(CLOSE-DELAY(CLOSE,1),0),12,1)/SMA(ABS(CLOSE-DELAY(CLOSE,1)),12,1)*100,12))/(MAX(SMA(MAX(CLOSE-DELAY(CLOSE,1),0),12,1)/SMA(ABS(CLOSE-DELAY(CLOSE,1)),12,1)*100,12)-MIN(SMA(MAX(CLOSE-DELAY(CLOSE,1),0),12,1)/SMA(ABS(CLOSE-DELAY(CLOSE,1)),12,1)*100,12))", "description": "RSI的标准化版本。", "category": "动量"},
    {"name": "alpha163", "expression": "RANK(((((-1 * RET) * MEAN(VOLUME,20)) * VWAP) * (HIGH - CLOSE)))", "description": "收益、成交量、均价、日内波动的综合排名。", "category": "综合"},
    {"name": "alpha164", "expression": "SMA(( ((CLOSE>DELAY(CLOSE,1))?1/(CLOSE-DELAY(CLOSE,1)):1) - MIN( ((CLOSE>DELAY(CLOSE,1))?1/(CLOSE-DELAY(CLOSE,1)):1) ,12) )/(HIGH-LOW)*100,13,2)", "description": "价格变化倒数的加权平均。", "category": "动量"},
    {"name": "alpha166", "expression": "-20* ( 20-1 ) ^1.5*SUM(CLOSE/DELAY(CLOSE,1)-1-MEAN(CLOSE/DELAY(CLOSE,1)-1,20),20)/((20-1)*(20-2)(SUM((CLOSE/DELAY(CLOSE,1),20)^2,20))^1.5)", "description": "价格变化率的偏度计算。", "category": "统计"},
    {"name": "alpha167", "expression": "SUM((CLOSE-DELAY(CLOSE,1)>0?CLOSE-DELAY(CLOSE,1):0),12)", "description": "12日上涨幅度累加。", "category": "动量"},
    {"name": "alpha168", "expression": "(-1*VOLUME/MEAN(VOLUME,20))", "description": "成交量相对均值的负值。", "category": "成交量"},
    {"name": "alpha169", "expression": "SMA(MEAN(DELAY(SMA(CLOSE-DELAY(CLOSE,1),9,1),1),12)-MEAN(DELAY(SMA(CLOSE-DELAY(CLOSE,1),9,1),1),26),10,1)", "description": "类似MACD的复杂计算。", "category": "趋势"},
    {"name": "alpha170", "expression": "((((RANK((1 / CLOSE)) * VOLUME) / MEAN(VOLUME,20)) * ((HIGH * RANK((HIGH - CLOSE))) / (SUM(HIGH, 5) /5))) - RANK((VWAP - DELAY(VWAP, 5))))", "description": "多因子组合，包括价格倒数、成交量、高价位置、均价变化。", "category": "综合"},
    {"name": "alpha171", "expression": "((-1 * ((LOW - CLOSE) * (OPEN^5))) / ((CLOSE - HIGH) * (CLOSE^5)))", "description": "低价收盘差与高价收盘差的幂次比。", "category": "价格"},
    {"name": "alpha172", "expression": "MEAN(ABS(SUM((LD>0 & LD>HD)?LD:0,14)*100/SUM(TR,14)-SUM((HD>0 &HD>LD)?HD:0,14)*100/SUM(TR,14))/(SUM((LD>0 & LD>HD)?LD:0,14)*100/SUM(TR,14)+SUM((HD>0 &HD>LD)?HD:0,14)*100/SUM(TR,14))*100,6)", "description": "类似DMI指标的计算。", "category": "趋势"},
    {"name": "alpha173", "expression": "3*SMA(CLOSE,13,2)-2*SMA(SMA(CLOSE,13,2),13,2)+SMA(SMA(SMA(LOG(CLOSE),13,2),13,2),13,2)", "description": "收盘价与收盘价对数的多重平滑组合。", "category": "趋势"},
    {"name": "alpha174", "expression": "SMA((CLOSE>DELAY(CLOSE,1)?STD(CLOSE,20):0),20,1)", "description": "上涨时波动率的加权平均。", "category": "波动"},
    {"name": "alpha175", "expression": "MEAN(MAX(MAX((HIGH-LOW),ABS(DELAY(CLOSE,1)-HIGH)),ABS(DELAY(CLOSE,1)-LOW)),6)", "description": "6日最大波动的平均。", "category": "波动"},
    {"name": "alpha176", "expression": "CORR(RANK(((CLOSE - TSMIN(LOW, 12)) / (TSMAX(HIGH, 12) - TSMIN(LOW,12)))), RANK(VOLUME), 6)", "description": "价格相对位置与成交量的相关性。", "category": "量价"},
    {"name": "alpha177", "expression": "((20-HIGHDAY(HIGH,20))/20)*100", "description": "距离最高价天数比例。", "category": "时间"},
    {"name": "alpha178", "expression": "(CLOSE-DELAY(CLOSE,1))/DELAY(CLOSE,1)*VOLUME", "description": "价格变化率与成交量的乘积。", "category": "量价"},
    {"name": "alpha179", "expression": "(RANK(CORR(VWAP, VOLUME, 4)) *RANK(CORR(RANK(LOW), RANK(MEAN(VOLUME,50)), 12)))", "description": "均价与成交量相关性、最低价与成交量均值排名相关性的交互。", "category": "量价"},
    {"name": "alpha180", "expression": "((MEAN(VOLUME,20) < VOLUME) ? ((-1 * TSRANK(ABS(DELTA(CLOSE, 7)), 60)) * SIGN(DELTA(CLOSE, 7)) : (-1 *VOLUME)))", "description": "成交量放大时，根据价格变化方向排名；否则返回负成交量。", "category": "量价"},
    {"name": "alpha181", "expression": "SUM(((CLOSE/DELAY(CLOSE,1)-1)-MEAN((CLOSE/DELAY(CLOSE,1)-1),20))-(BANCHMARKINDEXCLOSE-MEAN(BANCHMARKINDEXCLOSE,20))^2,20)/SUM((BANCHMARKINDEXCLOSE-MEAN(BANCHMARKINDEXCLOSE,20))^3)", "description": "个股收益与指数收益的复杂统计关系。", "category": "统计"},
    {"name": "alpha182", "expression": "COUNT((CLOSE>OPEN & BANCHMARKINDEXCLOSE>BANCHMARKINDEXOPEN)OR(CLOSE<OPEN & BANCHMARKINDEXCLOSE<BANCHMARKINDEXOPEN),20)/20", "description": "个股与大盘同向涨跌的比例。", "category": "统计"},
    {"name": "alpha183", "expression": "MAX(SUMAC(CLOSE-MEAN(CLOSE,24)))-MIN(SUMAC(CLOSE-MEAN(CLOSE,24)))/STD(CLOSE,24)", "description": "价格偏离均值的累积极值与波动率的比。", "category": "统计"},
    {"name": "alpha184", "expression": "(RANK(CORR(DELAY((OPEN - CLOSE), 1), CLOSE, 200)) + RANK((OPEN - CLOSE)))", "description": "滞后日内涨幅与收盘价相关性排名、日内涨幅排名的和。", "category": "量价"},
    {"name": "alpha185", "expression": "RANK((-1 * ((1 - (OPEN / CLOSE))^2)))", "description": "开盘价与收盘价偏离平方的排名。", "category": "价格"},
    {"name": "alpha186", "expression": "(MEAN(ABS(SUM((LD>0 & LD>HD)?LD:0,14)*100/SUM(TR,14)-SUM((HD>0 & HD>LD)?HD:0,14)*100/SUM(TR,14))/(SUM((LD>0 & LD>HD)?LD:0,14)*100/SUM(TR,14)+SUM((HD>0 & HD>LD)?HD:0,14)*100/SUM(TR,14))*100,6)+DELAY(MEAN(ABS(SUM((LD>0 & LD>HD)?LD:0,14)*100/SUM(TR,14)-SUM((HD>0 & HD>LD)?HD:0,14)*100/SUM(TR,14))/(SUM((LD>0 & LD>HD)?LD:0,14)*100/SUM(TR,14)+SUM((HD>0 & HD>LD)?HD:0,14)*100/SUM(TR,14))*100,6),6))/2", "description": "类似DMI指标的平滑版本。", "category": "趋势"},
    {"name": "alpha187", "expression": "SUM((OPEN<=DELAY(OPEN,1)?0:MAX((HIGH-OPEN),(OPEN-DELAY(OPEN,1)))),20)", "description": "开盘价上涨时的开盘价与高价差累加。", "category": "价格"},
    {"name": "alpha188", "expression": "((HIGH-LOW–SMA(HIGH-LOW,11,2))/SMA(HIGH-LOW,11,2))*100", "description": "日内波幅相对其均值的偏离百分比。", "category": "波动"},
    {"name": "alpha189", "expression": "MEAN(ABS(CLOSE-MEAN(CLOSE,6)),6)", "description": "价格偏离6日均值的平均绝对偏差。", "category": "波动"},
    {"name": "alpha191", "expression": "((CORR(MEAN(VOLUME,20), LOW, 5) + ((HIGH + LOW) / 2)) - CLOSE)", "description": "成交量与最低价相关性、日内中点与收盘价的偏离。", "category": "量价"},
]

ALPHA191_BASE_FUNCTIONS = [
    {"name": "Log", "syntax": "Log(sr)", "description": "自然对数函数。"},
    {"name": "Rank", "syntax": "Rank(sr)", "description": "截面升序排序并转化为百分比。"},
    {"name": "Delta", "syntax": "Delta(sr, period)", "description": "period日差分，当前值与period期前的差。"},
    {"name": "Delay", "syntax": "Delay(sr, period)", "description": "period阶滞后项，返回period期前的值。"},
    {"name": "Corr", "syntax": "Corr(x, y, window)", "description": "window日滚动相关系数。"},
    {"name": "Cov", "syntax": "Cov(x, y, window)", "description": "window日滚动协方差。"},
    {"name": "Sum", "syntax": "Sum(sr, window)", "description": "window日滚动求和。"},
    {"name": "Prod", "syntax": "Prod(sr, window)", "description": "window日滚动求乘积。"},
    {"name": "Mean", "syntax": "Mean(sr, window)", "description": "window日滚动求均值。"},
    {"name": "Std", "syntax": "Std(sr, window)", "description": "window日滚动求标准差。"},
    {"name": "Tsrank", "syntax": "Tsrank(sr, window)", "description": "window日序列末尾值的顺位。"},
    {"name": "Tsmax", "syntax": "Tsmax(sr, window)", "description": "window日滚动求最大值。"},
    {"name": "Tsmin", "syntax": "Tsmin(sr, window)", "description": "window日滚动求最小值。"},
    {"name": "Sign", "syntax": "Sign(sr)", "description": "符号函数，返回1、-1或0。"},
    {"name": "Max", "syntax": "Max(sr1, sr2)", "description": "逐元素最大值。"},
    {"name": "Min", "syntax": "Min(sr1, sr2)", "description": "逐元素最小值。"},
    {"name": "Rowmax", "syntax": "Rowmax(sr)", "description": "行最大值。"},
    {"name": "Rowmin", "syntax": "Rowmin(sr)", "description": "行最小值。"},
    {"name": "Sma", "syntax": "Sma(sr, n, m)", "description": "SMA均值，n周期m权重的指数移动平均。"},
    {"name": "Abs", "syntax": "Abs(sr)", "description": "求绝对值。"},
    {"name": "Sequence", "syntax": "Sequence(n)", "description": "生成1~n的等差序列。"},
    {"name": "Regbeta", "syntax": "Regbeta(sr, x)", "description": "线性回归斜率。"},
    {"name": "Decaylinear", "syntax": "Decaylinear(sr, window)", "description": "线性衰减移动平均，近期数据权重更高。"},
    {"name": "Lowday", "syntax": "Lowday(sr, window)", "description": "window日内最低价出现的天数。"},
    {"name": "Highday", "syntax": "Highday(sr, window)", "description": "window日内最高价出现的天数。"},
    {"name": "Wma", "syntax": "Wma(sr, window)", "description": "加权移动平均，权重按0.9衰减。"},
    {"name": "Count", "syntax": "Count(cond, window)", "description": "window日内满足条件的次数。"},
    {"name": "Sumif", "syntax": "Sumif(sr, window, cond)", "description": "满足条件的值在window日内的累加。"},
    {"name": "Returns", "syntax": "Returns(df)", "description": "计算日收益率。"},
]


ALPHA158_BASE_FUNCTIONS = [
    {"name": "Ref", "syntax": "Ref(x, d)", "description": "引用d天前的数据。"},
    {"name": "Mean", "syntax": "Mean(x, d)", "description": "d日移动平均值。"},
    {"name": "Std", "syntax": "Std(x, d)", "description": "d日标准差。"},
    {"name": "Max", "syntax": "Max(x, d)", "description": "d日最大值。"},
    {"name": "Min", "syntax": "Min(x, d)", "description": "d日最小值。"},
    {"name": "Sum", "syntax": "Sum(x, d)", "description": "d日求和。"},
    {"name": "Rank", "syntax": "Rank(x, d)", "description": "d日排名百分位。"},
    {"name": "Corr", "syntax": "Corr(x, y, d)", "description": "d日相关系数。"},
    {"name": "Slope", "syntax": "Slope(x, d)", "description": "d日线性回归斜率。"},
    {"name": "Rsquare", "syntax": "Rsquare(x, d)", "description": "d日线性回归R²。"},
    {"name": "Resi", "syntax": "Resi(x, d)", "description": "d日线性回归残差。"},
    {"name": "Quantile", "syntax": "Quantile(x, d, q)", "description": "d日q分位数。"},
    {"name": "IdxMax", "syntax": "IdxMax(x, d)", "description": "d日内最大值出现的位置。"},
    {"name": "IdxMin", "syntax": "IdxMin(x, d)", "description": "d日内最小值出现的位置。"},
    {"name": "Greater", "syntax": "Greater(x, y)", "description": "取较大值。"},
    {"name": "Less", "syntax": "Less(x, y)", "description": "取较小值。"},
    {"name": "Log", "syntax": "Log(x)", "description": "自然对数。"},
    {"name": "Abs", "syntax": "Abs(x)", "description": "绝对值。"},
    {"name": "Sign", "syntax": "Sign(x)", "description": "符号函数。"},
]

ALPHA158_KBAR_FACTORS = [
    {"name": "KMID", "expression": "($close-$open)/$open", "description": "收盘价相对开盘价的位置，衡量当日涨跌幅度。正值表示上涨，负值表示下跌。", "category": "K线形态"},
    {"name": "KLEN", "expression": "($high-$low)/$open", "description": "日内波幅，衡量当日波动性。值越大表示当日波动越剧烈。", "category": "K线形态"},
    {"name": "KMID2", "expression": "($close-$open)/($high-$low+1e-12)", "description": "实体相对波幅，K线实体占日内波幅的比例。值越接近1表示实体越大，越接近0表示实体越小。", "category": "K线形态"},
    {"name": "KUP", "expression": "($high-Greater($open, $close))/$open", "description": "上影线相对开盘价比例。值越大表示上影线越长，可能暗示上方压力较大。", "category": "K线形态"},
    {"name": "KUP2", "expression": "($high-Greater($open, $close))/($high-$low+1e-12)", "description": "上影线相对波幅比例。衡量上影线占日内波幅的比例。", "category": "K线形态"},
    {"name": "KLOW", "expression": "(Less($open, $close)-$low)/$open", "description": "下影线相对开盘价比例。值越大表示下影线越长，可能暗示下方支撑较强。", "category": "K线形态"},
    {"name": "KLOW2", "expression": "(Less($open, $close)-$low)/($high-$low+1e-12)", "description": "下影线相对波幅比例。衡量下影线占日内波幅的比例。", "category": "K线形态"},
    {"name": "KSFT", "expression": "(2*$close-$high-$low)/$open", "description": "收盘价相对日内中点位置。正值表示收盘价在日内中点之上，负值表示之下。", "category": "K线形态"},
    {"name": "KSFT2", "expression": "(2*$close-$high-$low)/($high-$low+1e-12)", "description": "收盘价相对日内中点比例。值在-1到1之间，衡量收盘价在日内区间的相对位置。", "category": "K线形态"},
]

ALPHA158_PRICE_FACTORS = [
    {"name": "OPEN0", "expression": "$open/$close", "description": "开盘价相对收盘价。值大于1表示低开，小于1表示高开。", "category": "价格"},
    {"name": "HIGH0", "expression": "$high/$close", "description": "最高价相对收盘价。值大于1表示有上影线，等于1表示收盘即最高。", "category": "价格"},
    {"name": "LOW0", "expression": "$low/$close", "description": "最低价相对收盘价。值小于1表示有下影线，等于1表示收盘即最低。", "category": "价格"},
    {"name": "VWAP0", "expression": "$vwap/$close", "description": "成交量加权均价相对收盘价。值大于1表示收盘价低于均价，可能暗示尾盘下跌。", "category": "价格"},
]

ROLLING_FACTOR_TEMPLATES = [
    {"name": "ROC", "expression": "Ref($close, d)/$close", "description": "d日价格变化率。衡量过去d天的价格变动幅度。", "category": "动量"},
    {"name": "MA", "expression": "Mean($close, d)/$close", "description": "d日移动平均相对当前价格。衡量当前价格相对均值的偏离程度。", "category": "趋势"},
    {"name": "STD", "expression": "Std($close, d)/$close", "description": "d日价格标准差相对当前价格。衡量价格波动性。", "category": "波动"},
    {"name": "BETA", "expression": "Slope($close, d)/$close", "description": "d日线性回归斜率。衡量价格趋势方向和强度。", "category": "趋势"},
    {"name": "RSQR", "expression": "Rsquare($close, d)", "description": "d日线性回归R²。衡量价格趋势的拟合程度，值越大趋势越明显。", "category": "趋势"},
    {"name": "RESI", "expression": "Resi($close, d)/$close", "description": "d日线性回归残差相对当前价格。衡量价格偏离趋势线的程度。", "category": "趋势"},
    {"name": "MAX", "expression": "Max($high, d)/$close", "description": "d日最高价相对当前价格。衡量当前价格相对近期高点的位置。", "category": "位置"},
    {"name": "MIN", "expression": "Min($low, d)/$close", "description": "d日最低价相对当前价格。衡量当前价格相对近期低点的位置。", "category": "位置"},
    {"name": "QTLU", "expression": "Quantile($close, d, 0.8)/$close", "description": "d日80%分位数相对当前价格。衡量当前价格相对高分位的位置。", "category": "位置"},
    {"name": "QTLD", "expression": "Quantile($close, d, 0.2)/$close", "description": "d日20%分位数相对当前价格。衡量当前价格相对低分位的位置。", "category": "位置"},
    {"name": "RANK", "expression": "Rank($close, d)", "description": "d日价格排名百分位。值在0-1之间，衡量当前价格在近期价格中的相对位置。", "category": "位置"},
    {"name": "RSV", "expression": "($close-Min($low,d))/(Max($high,d)-Min($low,d)+1e-12)", "description": "d日相对位置(Relative Strength Value)。类似KDJ中的RSV，衡量当前价格在日内区间的位置。", "category": "位置"},
    {"name": "IMAX", "expression": "IdxMax($high, d)/d", "description": "距离前次最高价的天数比例。值越小表示刚创新高不久。", "category": "时间"},
    {"name": "IMIN", "expression": "IdxMin($low, d)/d", "description": "距离前次最低价的天数比例。值越小表示刚创新低不久。", "category": "时间"},
    {"name": "IMXD", "expression": "(IdxMax($high,d)-IdxMin($low,d))/d", "description": "最高价与最低价出现时间差。衡量价格波动的时间分布。", "category": "时间"},
    {"name": "CORR", "expression": "Corr($close, Log($volume+1), d)", "description": "d日价格与成交量对数的相关性。正值表示量价同向，负值表示量价背离。", "category": "量价"},
    {"name": "CORD", "expression": "Corr($close/Ref($close,1), Log($volume/Ref($volume,1)+1), d)", "description": "d日价格变化与成交量变化的相关性。衡量量价变化的同步性。", "category": "量价"},
    {"name": "CNTP", "expression": "Mean($close>Ref($close,1), d)", "description": "d日上涨天数占比。衡量近期上涨频率。", "category": "统计"},
    {"name": "CNTN", "expression": "Mean($close<Ref($close,1), d)", "description": "d日下跌天数占比。衡量近期下跌频率。", "category": "统计"},
    {"name": "CNTD", "expression": "Mean($close>Ref($close,1),d)-Mean($close<Ref($close,1),d)", "description": "上涨下跌天数差。衡量近期涨跌倾向。", "category": "统计"},
    {"name": "SUMP", "expression": "Sum(Greater($close-Ref($close,1),0),d)/(Sum(Abs($close-Ref($close,1)),d)+1e-12)", "description": "d日上涨幅度占比。衡量上涨贡献的幅度比例。", "category": "统计"},
    {"name": "SUMN", "expression": "Sum(Greater(Ref($close,1)-$close,0),d)/(Sum(Abs($close-Ref($close,1)),d)+1e-12)", "description": "d日下跌幅度占比。衡量下跌贡献的幅度比例。", "category": "统计"},
    {"name": "SUMD", "expression": "(Sum(Greater($close-Ref($close,1),0),d)-Sum(Greater(Ref($close,1)-$close,0),d))/(Sum(Abs($close-Ref($close,1)),d)+1e-12)", "description": "d日涨跌幅度差。衡量净涨跌幅度倾向。", "category": "统计"},
    {"name": "VMA", "expression": "Mean($volume, d)/($volume+1e-12)", "description": "d日成交量均值相对当前成交量。衡量当前成交量相对均值的水平。", "category": "成交量"},
    {"name": "VSTD", "expression": "Std($volume, d)/($volume+1e-12)", "description": "d日成交量标准差相对当前成交量。衡量成交量波动性。", "category": "成交量"},
    {"name": "WVMA", "expression": "Std(Abs($close/Ref($close,1)-1)*$volume,d)/(Mean(Abs($close/Ref($close,1)-1)*$volume,d)+1e-12)", "description": "成交量加权波动率。衡量成交金额的波动性。", "category": "成交量"},
    {"name": "VSUMP", "expression": "Sum(Greater($volume-Ref($volume,1),0),d)/(Sum(Abs($volume-Ref($volume,1)),d)+1e-12)", "description": "d日成交量增加幅度占比。衡量放量倾向。", "category": "成交量"},
    {"name": "VSUMN", "expression": "Sum(Greater(Ref($volume,1)-$volume,0),d)/(Sum(Abs($volume-Ref($volume,1)),d)+1e-12)", "description": "d日成交量减少幅度占比。衡量缩量倾向。", "category": "成交量"},
    {"name": "VSUMD", "expression": "(Sum(Greater($volume-Ref($volume,1),0),d)-Sum(Greater(Ref($volume,1)-$volume,0),d))/(Sum(Abs($volume-Ref($volume,1)),d)+1e-12)", "description": "d日成交量增减差。衡量净放量倾向。", "category": "成交量"},
]

WINDOWS = [5, 10, 20, 30, 60]

ALPHA158_ROLLING_FACTORS = []
for template in ROLLING_FACTOR_TEMPLATES:
    for window in WINDOWS:
        factor = {
            "name": f"{template['name']}{window}",
            "expression": template["expression"].replace("d", str(window)),
            "description": template["description"].replace("d日", f"{window}日"),
            "category": template["category"],
        }
        ALPHA158_ROLLING_FACTORS.append(factor)

ALPHA158_ALL_FACTORS = ALPHA158_KBAR_FACTORS + ALPHA158_PRICE_FACTORS + ALPHA158_ROLLING_FACTORS

ALPHA158_FACTORS_MAP = {f["name"]: f for f in ALPHA158_ALL_FACTORS}

ALPHA158_CATEGORIES = {
    "K线形态": "K线形态因子，反映当日K线的形态特征",
    "价格": "价格因子，反映不同价格之间的相对关系",
    "动量": "动量因子，反映价格变化趋势",
    "趋势": "趋势因子，反映价格的线性趋势特征",
    "波动": "波动因子，反映价格的波动性",
    "位置": "位置因子，反映当前价格在近期价格区间中的位置",
    "时间": "时间因子，反映价格极值出现的时间特征",
    "量价": "量价因子，反映价格与成交量的关系",
    "统计": "统计因子，反映价格变化的统计特征",
    "成交量": "成交量因子，反映成交量的特征",
}


@router.get("/alpha158")
def get_alpha158_docs() -> ApiResponse:
    """获取 Alpha158 因子完整文档"""
    return ApiResponse(
        success=True,
        data={
            "factors": ALPHA158_ALL_FACTORS,
            "categories": ALPHA158_CATEGORIES,
            "base_functions": ALPHA158_BASE_FUNCTIONS,
            "total_count": len(ALPHA158_ALL_FACTORS),
        },
    )


@router.get("/alpha101")
def get_alpha101_docs() -> ApiResponse:
    """获取 Alpha101 因子完整文档"""
    return ApiResponse(
        success=True,
        data={
            "factors": ALPHA101_FACTORS,
            "base_functions": ALPHA101_BASE_FUNCTIONS,
            "total_count": len(ALPHA101_FACTORS),
        },
    )


@router.get("/alpha191")
def get_alpha191_docs() -> ApiResponse:
    """获取 Alpha191 因子完整文档"""
    return ApiResponse(
        success=True,
        data={
            "factors": ALPHA191_FACTORS,
            "base_functions": ALPHA191_BASE_FUNCTIONS,
            "total_count": len(ALPHA191_FACTORS),
        },
    )


@router.get("/alpha158/{factor_name}")
def get_factor_detail(factor_name: str) -> ApiResponse:
    """获取单个因子详情"""
    factor = ALPHA158_FACTORS_MAP.get(factor_name)
    if factor:
        return ApiResponse(success=True, data=factor)
    return ApiResponse(success=False, message=f"因子 {factor_name} 不存在", data=None)


@router.get("/alpha158/categories")
def get_factor_categories() -> ApiResponse:
    """获取因子分类列表"""
    return ApiResponse(success=True, data=ALPHA158_CATEGORIES)


@router.get("/alpha158/category/{category}")
def get_factors_by_category(category: str) -> ApiResponse:
    """获取指定分类的因子列表"""
    factors = [f for f in ALPHA158_ALL_FACTORS if f["category"] == category]
    if factors:
        return ApiResponse(success=True, data={"category": category, "factors": factors})
    return ApiResponse(success=False, message=f"分类 {category} 不存在", data=None)
