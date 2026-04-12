import numpy as np
import pandas as pd
from typing import Any, Dict, List, Optional

from app.utils.mlflow_reader import mlflow_reader


class ReportService:

    @staticmethod
    def get_full_report(experiment_id: str, run_id: str) -> Dict[str, Any]:
        run_detail = mlflow_reader.get_run_detail(experiment_id, run_id)
        if not run_detail:
            return {"error": f"Run {run_id} not found"}

        key_metrics = _extract_key_metrics(run_detail.get("metrics", {}))
        
        port_analysis = mlflow_reader.load_port_analysis(experiment_id, run_id)
        
        model_params_structured = run_detail.get("params", {})
        portfolio_data = ReportService._get_portfolio_chart_data(experiment_id, run_id)
        ic_analysis_data = ReportService._get_ic_chart_data(experiment_id, run_id)
        risk_metrics = ReportService._get_risk_metrics(experiment_id, run_id)
        prediction_stats = ReportService._get_prediction_stats(experiment_id, run_id)
        pred_label_data = ReportService._get_pred_label_data(experiment_id, run_id)
        rolling_stats = ReportService._get_rolling_stats(experiment_id, run_id)
        monthly_returns = ReportService._get_monthly_returns(experiment_id, run_id)
        annual_returns = ReportService._get_annual_returns(experiment_id, run_id)
        qlib_analysis = ReportService._get_qlib_analysis(experiment_id, run_id)

        if portfolio_data.get("available") and portfolio_data.get("daily_return"):
            daily_returns = portfolio_data["daily_return"].get("strategy", [])
            benchmark_returns = portfolio_data["daily_return"].get("benchmark", [])
            
            if daily_returns:
                returns_arr = np.array([r for r in daily_returns if r is not None and not np.isnan(r)])
                if len(returns_arr) > 0:
                    total_days = len(returns_arr)
                    cumulative_curve = np.cumprod(1 + returns_arr)
                    total_return = cumulative_curve[-1] - 1
                    
                    key_metrics["cumulative_return"] = float(total_return)
                    
                    key_metrics["annualized_return"] = float((1 + total_return) ** (252 / total_days) - 1)
                    
                    mean_ret = np.mean(returns_arr)
                    std_ret = np.std(returns_arr, ddof=1)
                    if std_ret > 0:
                        key_metrics["sharpe_ratio"] = float(mean_ret / std_ret * np.sqrt(252))
                    
                    running_max = np.maximum.accumulate(cumulative_curve)
                    drawdown = (cumulative_curve - running_max) / running_max
                    key_metrics["max_drawdown"] = float(drawdown.min())
                    
                    if benchmark_returns:
                        bench_arr = np.array([r for r in benchmark_returns if r is not None and not np.isnan(r)])
                        if len(bench_arr) == len(returns_arr):
                            excess_returns = returns_arr - bench_arr
                            excess_mean = np.mean(excess_returns)
                            excess_std = np.std(excess_returns, ddof=1)
                            if excess_std > 0:
                                key_metrics["information_ratio"] = float(excess_mean / excess_std * np.sqrt(252))

        return {
            "run_info": {
                "run_id": run_detail["run_id"],
                "run_name": run_detail.get("run_name", ""),
                "status": run_detail.get("status"),
                "start_time": run_detail.get("start_time"),
                "end_time": run_detail.get("end_time"),
                "duration_seconds": run_detail.get("duration_seconds"),
            },
            "key_metrics": key_metrics,
            "model_params": model_params_structured,
            "portfolio_data": portfolio_data,
            "ic_analysis": ic_analysis_data,
            "risk_metrics": risk_metrics,
            "prediction_stats": prediction_stats,
            "pred_label_data": pred_label_data,
            "rolling_stats": rolling_stats,
            "monthly_returns": monthly_returns,
            "annual_returns": annual_returns,
            "qlib_analysis": qlib_analysis,
            "all_metrics_raw": {
                **run_detail.get("metrics", {}), 
                **(port_analysis or {}),
                **(mlflow_reader.load_indicator_analysis(experiment_id, run_id) or {}),
            },
            "tags": run_detail.get("tags", {}),
        }

    @staticmethod
    def _get_portfolio_chart_data(experiment_id: str, run_id: str) -> Dict[str, Any]:
        report_df = mlflow_reader.load_portfolio_report(experiment_id, run_id)
        if report_df is None or report_df.empty:
            return {"available": False, "error": "No portfolio report data"}

        if not isinstance(report_df.index, pd.DatetimeIndex):
            report_df = report_df.copy()
            try:
                report_df.index = pd.to_datetime(report_df.index)
            except Exception:
                pass

        dates = [d.strftime("%Y-%m-%d") if hasattr(d, "strftime") else str(d) for d in report_df.index]

        result: Dict[str, Any] = {"dates": dates, "available": True}

        if "return" in report_df.columns:
            cum_ret = (1 + report_df["return"]).cumprod()
            result["cumulative_return"] = {
                "strategy": cum_ret.tolist(),
                "strategy_with_cost": cum_ret.tolist(),
            }
        if "bench" in report_df.columns:
            cum_bench = (1 + report_df["bench"]).cumprod()
            result["cumulative_return"]["benchmark"] = cum_bench.tolist()

        if "return" in report_df.columns and "bench" in report_df.columns:
            excess = report_df["return"] - report_df["bench"]
            result["excess_return"] = excess.tolist()

        if "turnover" in report_df.columns:
            result["turnover"] = report_df["turnover"].tolist()

        def calc_drawdown(series):
            running_max = series.cummax()
            return (series - running_max) / running_max

        if "return" in report_df.columns:
            strategy_dd = calc_drawdown((1 + report_df["return"]).cumprod())
            result["drawdown"] = {"strategy": strategy_dd.tolist()}
        if "bench" in report_df.columns:
            bench_dd = calc_drawdown((1 + report_df["bench"]).cumprod())
            result["drawdown"]["benchmark"] = bench_dd.tolist()

        if "return" in report_df.columns and "bench" in report_df.columns:
            result["daily_return"] = {
                "strategy": report_df["return"].tolist(),
                "benchmark": report_df["bench"].tolist(),
            }

        return result

    @staticmethod
    def _get_ic_chart_data(experiment_id: str, run_id: str) -> Dict[str, Any]:
        ic_data = mlflow_reader.load_ic_analysis(experiment_id, run_id)
        ic_df = ic_data.get("ic")
        ric_df = ic_data.get("ric")

        result: Dict[str, Any] = {"available": bool(ic_df is not None)}

        if ic_df is not None and len(ic_df) > 0:
            import pandas as pd
            is_series = isinstance(ic_df, pd.Series)
            if hasattr(ic_df.index, "to_list"):
                dates = [str(d)[:10] for d in ic_df.index.to_list()]
            else:
                dates = list(range(len(ic_df)))
            ic_values = ic_df.tolist() if is_series else (ic_df.iloc[:, 0].tolist() if len(ic_df.columns) > 0 else [])
            result["ic_series"] = {"dates": dates, "values": ic_values}
            result["summary"] = {
                "mean_ic": float(np.nanmean(ic_values)) if ic_values else None,
                "std_ic": float(np.nanstd(ic_values)) if ic_values else None,
                "ir": float(np.nanmean(ic_values) / np.nanstd(ic_values)) if ic_values and np.nanstd(ic_values) > 0 else None,
                "hit_rate": float((np.array(ic_values) > 0).mean()) if ic_values else None,
            }

        if ric_df is not None and len(ric_df) > 0:
            is_series_ric = isinstance(ric_df, pd.Series)
            if hasattr(ric_df.index, "to_list"):
                dates_ric = [str(d)[:10] for d in ric_df.index.to_list()]
            else:
                dates_ric = list(range(len(ric_df)))
            ric_values = ric_df.tolist() if is_series_ric else (ric_df.iloc[:, 0].tolist() if len(ric_df.columns) > 0 else [])
            result["ric_series"] = {"dates": dates_ric, "values": ric_values}

        return result

    @staticmethod
    def _get_risk_metrics(experiment_id: str, run_id: str) -> Dict[str, Any]:
        port_analysis = mlflow_reader.load_port_analysis(experiment_id, run_id)
        if port_analysis:
            metrics = {}
            
            dd_keys_priority = [
                "1day.excess_return_with_cost.max_drawdown",
                "1day.excess_return_without_cost.max_drawdown",
            ]
            for k in dd_keys_priority:
                if k in port_analysis and port_analysis[k] is not None:
                    metrics["max_drawdown"] = port_analysis[k]
                    break
            
            ann_keys_priority = [
                "1day.excess_return_with_cost.annualized_return",
                "1day.excess_return_without_cost.annualized_return",
            ]
            for k in ann_keys_priority:
                if k in port_analysis and port_analysis[k] is not None:
                    metrics["annualized_return"] = port_analysis[k]
                    break
            
            ir_keys_priority = [
                "1day.excess_return_with_cost.information_ratio",
                "1day.excess_return_without_cost.information_ratio",
            ]
            for k in ir_keys_priority:
                if k in port_analysis and port_analysis[k] is not None:
                    metrics["information_ratio"] = port_analysis[k]
                    break
            
            sharpe_keys_priority = [
                "1day.excess_return_with_cost.sharpe",
                "1day.excess_return_without_cost.sharpe",
            ]
            for k in sharpe_keys_priority:
                if k in port_analysis and port_analysis[k] is not None:
                    metrics["sharpe_ratio"] = port_analysis[k]
                    break
            
            for key, value in port_analysis.items():
                if "mean" in key and "annualized" not in key and "mean" not in metrics:
                    metrics["mean"] = value
                elif "std" in key and "std" not in metrics:
                    metrics["std"] = value
            
            if not metrics:
                metrics = port_analysis
            
            return {"available": True, "metrics": metrics}

        report_df = mlflow_reader.load_portfolio_report(experiment_id, run_id)
        if report_df is None or report_df.empty or "return" not in report_df.columns:
            return {"available": False}

        returns = report_df["return"].dropna()
        
        def calc_max_drawdown(returns_series: pd.Series) -> float:
            cum_ret = (1 + returns_series).cumprod()
            running_max = cum_ret.cummax()
            drawdown = (cum_ret - running_max) / running_max
            return float(drawdown.min())
        
        max_dd = calc_max_drawdown(returns) if len(returns) > 0 else None
        
        metrics = {
            "mean": float(returns.mean()),
            "std": float(returns.std()),
            "annualized_return": float(returns.mean() * 252),
            "max_drawdown": max_dd,
            "sharpe_ratio": float(returns.mean() / returns.std() * np.sqrt(252)) if returns.std() > 0 else None,
            "win_rate": float((returns > 0).mean()),
            "total_days": int(len(returns)),
        }
        return {"available": True, "metrics": metrics, "source": "computed_from_report"}

    @staticmethod
    def _get_prediction_stats(experiment_id: str, run_id: str) -> Dict[str, Any]:
        pred_df = mlflow_reader.load_prediction_data(experiment_id, run_id)
        if pred_df is None or pred_df.empty:
            return {"available": False}

        score_col = "score" if "score" in pred_df.columns else pred_df.columns[-1]
        scores = pred_df[score_col].dropna().astype(float)
        return {
            "available": True,
            "stats": {
                "count": int(len(scores)),
                "mean": float(scores.mean()),
                "std": float(scores.std()),
                "min": float(scores.min()),
                "max": float(scores.max()),
                "median": float(scores.median()),
                "q25": float(scores.quantile(0.25)),
                "q75": float(scores.quantile(0.75)),
            },
            "histogram": _compute_histogram(scores.values, bins=50),
        }

    @staticmethod
    def _get_pred_label_data(experiment_id: str, run_id: str) -> Dict[str, Any]:
        pred_label_df = mlflow_reader.load_prediction_data(experiment_id, run_id)
        if pred_label_df is None or pred_label_df.empty:
            return {"available": False}

        if "label" not in pred_label_df.columns or "score" not in pred_label_df.columns:
            return {"available": False, "error": "Missing label or score column"}

        labels = pred_label_df["label"].dropna()
        scores = pred_label_df["score"].dropna()

        common_idx = labels.index.intersection(scores.index)
        if len(common_idx) == 0:
            return {"available": False, "error": "No common index"}

        labels = labels.loc[common_idx]
        scores = scores.loc[common_idx]

        sample_size = min(2000, len(common_idx))
        if len(common_idx) > sample_size:
            sample_idx = np.random.choice(common_idx, sample_size, replace=False)
            labels = labels.loc[sample_idx]
            scores = scores.loc[sample_idx]

        correlation = float(np.corrcoef(labels.values, scores.values)[0, 1]) if len(labels) > 1 else None

        return {
            "available": True,
            "labels": labels.values.tolist(),
            "scores": scores.values.tolist(),
            "correlation": correlation,
            "count": int(len(labels)),
        }

    @staticmethod
    def _get_rolling_stats(experiment_id: str, run_id: str, window: int = 20) -> Dict[str, Any]:
        report_df = mlflow_reader.load_portfolio_report(experiment_id, run_id)
        if report_df is None or report_df.empty or "return" not in report_df.columns:
            return {"available": False}

        returns = report_df["return"].dropna()
        if len(returns) < window:
            return {"available": False, "error": "Not enough data for rolling stats"}

        dates = [str(d)[:10] for d in returns.index]

        rolling_mean = returns.rolling(window=window).mean()
        rolling_std = returns.rolling(window=window).std()
        rolling_sharpe = rolling_mean / rolling_std * np.sqrt(252)

        cum_returns = (1 + returns).cumprod()
        rolling_max = cum_returns.rolling(window=window).max()
        rolling_dd = (cum_returns - rolling_max) / rolling_max

        return {
            "available": True,
            "dates": dates,
            "window": window,
            "rolling_return": rolling_mean.tolist(),
            "rolling_volatility": (rolling_std * np.sqrt(252)).tolist(),
            "rolling_sharpe": rolling_sharpe.tolist(),
            "rolling_drawdown": rolling_dd.tolist(),
        }

    @staticmethod
    def _get_monthly_returns(experiment_id: str, run_id: str) -> Dict[str, Any]:
        report_df = mlflow_reader.load_portfolio_report(experiment_id, run_id)
        if report_df is None or report_df.empty or "return" not in report_df.columns:
            return {"available": False}

        if not isinstance(report_df.index, pd.DatetimeIndex):
            try:
                report_df = report_df.copy()
                report_df.index = pd.to_datetime(report_df.index)
            except Exception:
                return {"available": False}

        returns = report_df["return"].dropna()
        if len(returns) == 0:
            return {"available": False}

        monthly_returns = returns.resample('ME').apply(lambda x: (1 + x).prod() - 1)

        monthly_data = []
        for date, ret in monthly_returns.items():
            if pd.notna(ret):
                monthly_data.append({
                    "month": date.strftime("%Y-%m"),
                    "year": date.year,
                    "month_num": date.month,
                    "return": float(ret),
                })

        years = sorted(list(set([d["year"] for d in monthly_data])))
        months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

        heatmap_data = []
        for d in monthly_data:
            heatmap_data.append([str(d["year"]), d["month_num"] - 1, d["return"]])

        return {
            "available": True,
            "monthly_list": monthly_data,
            "years": [str(y) for y in years],
            "months": months,
            "heatmap_data": heatmap_data,
            "histogram": {
                "values": [d["return"] for d in monthly_data],
                "labels": [d["month"] for d in monthly_data],
            },
        }

    @staticmethod
    def _get_annual_returns(experiment_id: str, run_id: str) -> Dict[str, Any]:
        report_df = mlflow_reader.load_portfolio_report(experiment_id, run_id)
        if report_df is None or report_df.empty or "return" not in report_df.columns:
            return {"available": False}

        if not isinstance(report_df.index, pd.DatetimeIndex):
            try:
                report_df = report_df.copy()
                report_df.index = pd.to_datetime(report_df.index)
            except Exception:
                return {"available": False}

        returns = report_df["return"].dropna()
        if len(returns) == 0:
            return {"available": False}

        annual_returns = returns.resample('YE').apply(lambda x: (1 + x).prod() - 1)
        
        annual_data = []
        for date, ret in annual_returns.items():
            if pd.notna(ret):
                annual_data.append({
                    "year": date.year,
                    "return": float(ret),
                })

        annual_dict = {str(d["year"]): d["return"] for d in annual_data}
        
        benchmark_annual = {}
        if "bench" in report_df.columns:
            bench_returns = report_df["bench"].dropna()
            bench_annual = bench_returns.resample('YE').apply(lambda x: (1 + x).prod() - 1)
            for date, ret in bench_annual.items():
                if pd.notna(ret):
                    benchmark_annual[str(date.year)] = float(ret)

        return {
            "available": True,
            "annual_returns": annual_dict,
            "benchmark_annual_returns": benchmark_annual,
            "annual_list": annual_data,
        }

    @staticmethod
    def _get_qlib_analysis(experiment_id: str, run_id: str) -> Dict[str, Any]:
        return mlflow_reader.load_qlib_analysis_data(experiment_id, run_id)


def _extract_key_metrics(metrics: Dict[str, Any]) -> Dict[str, Any]:
    mapping = {
        "IC": "ic",
        "Rank IC": "rank_ic",
        "ICIR": "icir",
        "Rank ICIR": "rank_icir",
        "l2.valid": "l2_valid",
        "l2.train": "l2_train",
    }
    annualized_keys = [
        "1day.excess_return_with_cost.annualized_return",
        "1day.excess_return_without_cost.annualized_return",
    ]
    dd_keys = [
        "1day.excess_return_with_cost.max_drawdown",
        "1day.excess_return_without_cost.max_drawdown",
    ]
    ir_keys = [
        "1day.excess_return_with_cost.information_ratio",
        "1day.excess_return_without_cost.information_ratio",
    ]
    sharpe_keys = [
        "1day.excess_return_with_cost.sharpe",
        "1day.excess_return_without_cost.sharpe",
        "sharpe",
    ]
    cum_return_keys = [
        "1day.excess_return_with_cost.cumulative_return",
        "1day.excess_return_without_cost.cumulative_return",
    ]

    result: Dict[str, Any] = {}
    for key, alias in mapping.items():
        if key in metrics and metrics[key] is not None:
            result[alias] = metrics[key]

    for k in annualized_keys:
        if k in metrics and metrics[k] is not None:
            result.setdefault("annualized_return", metrics[k])
            break
    for k in dd_keys:
        if k in metrics and metrics[k] is not None:
            result.setdefault("max_drawdown", metrics[k])
            break
    for k in ir_keys:
        if k in metrics and metrics[k] is not None:
            result.setdefault("information_ratio", metrics[k])
            break
    for k in sharpe_keys:
        if k in metrics and metrics[k] is not None:
            result.setdefault("sharpe_ratio", metrics[k])
            break
    for k in cum_return_keys:
        if k in metrics and metrics[k] is not None:
            result.setdefault("cumulative_return", metrics[k])
            break

    return result


def _compute_histogram(values: np.ndarray, bins: int = 50) -> Dict[str, Any]:
    hist, bin_edges = np.histogram(values[~np.isnan(values)], bins=bins)
    return {
        "counts": [int(c) for c in hist],
        "bin_edges": [float(x) for x in bin_edges.tolist()],
        "bin_centers": [float((bin_edges[i] + bin_edges[i + 1]) / 2) for i in range(len(bin_edges) - 1)],
    }
