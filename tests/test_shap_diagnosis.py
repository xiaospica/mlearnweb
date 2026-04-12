# -*- coding: utf-8 -*-
"""
SHAP 计算诊断测试

用于诊断 SHAP 计算中特征数据获取失败的问题。
"""

import pickle
import sys
from pathlib import Path
from typing import Any, Dict, Optional

import numpy as np
import pandas as pd


def diagnose_dataset(run_path: str) -> Dict[str, Any]:
    """诊断数据集状态
    
    Args:
        run_path: MLflow run 目录路径
        
    Returns:
        诊断结果字典
    """
    run_path = Path(run_path)
    results = {
        "run_path": str(run_path),
        "checks": [],
        "errors": [],
        "recommendations": [],
    }
    
    print("=" * 60)
    print("SHAP 数据集诊断")
    print("=" * 60)
    
    dataset_path = run_path / "artifacts" / "dataset"
    params_pkl = run_path / "artifacts" / "params.pkl"
    
    if not dataset_path.exists():
        msg = f"数据集目录不存在: {dataset_path}"
        print(f"[ERROR] {msg}")
        results["errors"].append(msg)
        results["recommendations"].append("检查训练脚本是否正确保存了数据集")
        return results
    
    if not params_pkl.exists():
        msg = f"模型文件不存在: {params_pkl}"
        print(f"[ERROR] {msg}")
        results["errors"].append(msg)
        return results
    
    print(f"\n[CHECK] 加载数据集...")
    try:
        with open(dataset_path, "rb") as f:
            dataset = pickle.load(f)
        print(f"  数据集类型: {type(dataset).__name__}")
        print(f"  数据集模块: {type(dataset).__module__}")
        results["checks"].append({
            "name": "dataset_type",
            "value": f"{type(dataset).__module__}.{type(dataset).__name__}",
            "status": "ok"
        })
    except Exception as e:
        msg = f"加载数据集失败: {e}"
        print(f"[ERROR] {msg}")
        results["errors"].append(msg)
        return results
    
    print(f"\n[CHECK] 数据集属性...")
    important_attrs = ["segments", "handler", "_data", "data_loader"]
    for attr in important_attrs:
        has_attr = hasattr(dataset, attr)
        value = None
        if has_attr:
            value = getattr(dataset, attr)
            if value is not None:
                if attr == "segments":
                    value = list(value.keys()) if isinstance(value, dict) else str(value)
                elif hasattr(value, "__len__"):
                    value = f"len={len(value)}"
                else:
                    value = type(value).__name__
        print(f"  {attr}: {'存在' if has_attr else '不存在'} = {value}")
        results["checks"].append({
            "name": f"attr_{attr}",
            "exists": has_attr,
            "value": str(value) if value else None
        })
    
    if hasattr(dataset, "segments"):
        segments = dataset.segments
        print(f"\n[CHECK] Segments 信息:")
        for seg_name, seg_range in segments.items():
            print(f"  {seg_name}: {seg_range[0]} ~ {seg_range[1]}")
            results["checks"].append({
                "name": f"segment_{seg_name}",
                "range": f"{seg_range[0]} ~ {seg_range[1]}"
            })
    
    print(f"\n[CHECK] Handler 属性...")
    if hasattr(dataset, "handler"):
        handler = dataset.handler
        print(f"  Handler 类型: {type(handler).__name__}")
        print(f"  Handler 模块: {type(handler).__module__}")
        results["checks"].append({
            "name": "handler_type",
            "value": f"{type(handler).__module__}.{type(handler).__name__}"
        })
        
        handler_attrs = ["_data", "_infer", "_learn", "data_loader", "fetcher"]
        for attr in handler_attrs:
            has_attr = hasattr(handler, attr)
            value = None
            if has_attr:
                try:
                    value = getattr(handler, attr)
                    if value is not None:
                        if isinstance(value, pd.DataFrame):
                            value = f"DataFrame shape={value.shape}"
                        elif isinstance(value, np.ndarray):
                            value = f"ndarray shape={value.shape}"
                        elif hasattr(value, "__len__"):
                            value = f"len={len(value)}"
                        else:
                            value = type(value).__name__
                except Exception as e:
                    value = f"ERROR: {e}"
            print(f"  handler.{attr}: {'存在' if has_attr else '不存在'} = {value}")
            results["checks"].append({
                "name": f"handler_{attr}",
                "exists": has_attr,
                "value": str(value) if value else None
            })
        
        if hasattr(handler, "get_feature_config"):
            try:
                feat_config = handler.get_feature_config()
                print(f"  feature_config 类型: {type(feat_config)}")
                if isinstance(feat_config, tuple):
                    print(f"  feature_config 长度: {len(feat_config)}")
                    if len(feat_config) >= 2:
                        names = feat_config[1]
                        print(f"  特征名称数量: {len(names) if isinstance(names, list) else 'N/A'}")
                        if isinstance(names, list) and len(names) > 0:
                            print(f"  前5个特征: {names[:5]}")
                results["checks"].append({
                    "name": "feature_config",
                    "type": str(type(feat_config)),
                    "feature_count": len(feat_config[1]) if isinstance(feat_config, tuple) and len(feat_config) >= 2 else None
                })
            except Exception as e:
                print(f"  获取 feature_config 失败: {e}")
                results["errors"].append(f"get_feature_config 失败: {e}")
    else:
        print("  数据集没有 handler 属性")
        results["errors"].append("数据集缺少 handler 属性")
    
    print(f"\n[CHECK] 尝试 prepare 方法...")
    from qlib.data.dataset.handler import DataHandlerLP
    
    for segment in ["test", "valid", "train"]:
        if not hasattr(dataset, "segments") or segment not in dataset.segments:
            print(f"  {segment}: 跳过 (segment 不存在)")
            continue
            
        print(f"\n  Segment: {segment}")
        
        for data_key, key_name in [
            (None, "default"),
            (DataHandlerLP.DK_L, "learn"),
            (DataHandlerLP.DK_I, "infer"),
            (DataHandlerLP.DK_R, "raw"),
        ]:
            try:
                if data_key is None:
                    X = dataset.prepare(segment, col_set="feature")
                else:
                    X = dataset.prepare(segment, col_set="feature", data_key=data_key)
                
                if X is not None and not X.empty:
                    print(f"    {key_name}: 成功, shape={X.shape}, columns={len(X.columns)}")
                    print(f"      前5列: {X.columns[:5].tolist()}")
                    results["checks"].append({
                        "name": f"prepare_{segment}_{key_name}",
                        "status": "success",
                        "shape": X.shape,
                        "columns": X.columns[:5].tolist() if len(X.columns) >= 5 else X.columns.tolist()
                    })
                    break
                else:
                    print(f"    {key_name}: 返回空数据")
                    results["checks"].append({
                        "name": f"prepare_{segment}_{key_name}",
                        "status": "empty"
                    })
            except AttributeError as e:
                print(f"    {key_name}: AttributeError - {e}")
                results["checks"].append({
                    "name": f"prepare_{segment}_{key_name}",
                    "status": "error",
                    "error_type": "AttributeError",
                    "error": str(e)
                })
            except Exception as e:
                print(f"    {key_name}: {type(e).__name__} - {e}")
                results["checks"].append({
                    "name": f"prepare_{segment}_{key_name}",
                    "status": "error",
                    "error_type": type(e).__name__,
                    "error": str(e)
                })
    
    print(f"\n[CHECK] 检查 pred.pkl 文件...")
    for seg in ["test", "valid", "train"]:
        pred_file = run_path / "artifacts" / (f"pred_{seg}.pkl" if seg != "test" else "pred.pkl")
        if pred_file.exists():
            try:
                with open(pred_file, "rb") as f:
                    pred = pickle.load(f)
                print(f"  {seg}: 存在, shape={pred.shape if hasattr(pred, 'shape') else 'N/A'}")
                results["checks"].append({
                    "name": f"pred_{seg}",
                    "exists": True,
                    "shape": pred.shape if hasattr(pred, 'shape') else None
                })
            except Exception as e:
                print(f"  {seg}: 加载失败 - {e}")
                results["errors"].append(f"加载 pred_{seg}.pkl 失败: {e}")
        else:
            print(f"  {seg}: 不存在")
            results["checks"].append({
                "name": f"pred_{seg}",
                "exists": False
            })
    
    print("\n" + "=" * 60)
    print("诊断完成")
    print("=" * 60)
    
    if results["errors"]:
        print("\n发现的问题:")
        for err in results["errors"]:
            print(f"  - {err}")
    
    if not any(c.get("status") == "success" for c in results["checks"] if "prepare" in c.get("name", "")):
        results["recommendations"].append("数据集 prepare 方法无法返回特征数据")
        results["recommendations"].append("建议: 使用 task 配置重建数据集，而不是从 pickle 加载")
    
    if results["recommendations"]:
        print("\n建议:")
        for rec in results["recommendations"]:
            print(f"  - {rec}")
    
    return results


def diagnose_shap_with_task_config(run_path: str, provider_uri: Optional[str] = None) -> Dict[str, Any]:
    """使用 task 配置重建数据集进行诊断
    
    Args:
        run_path: MLflow run 目录路径
        provider_uri: QLib 数据目录
        
    Returns:
        诊断结果
    """
    run_path = Path(run_path)
    results = {
        "run_path": str(run_path),
        "checks": [],
        "errors": [],
    }
    
    print("=" * 60)
    print("使用 Task 配置重建数据集诊断")
    print("=" * 60)
    
    task_config_path = run_path / "artifacts" / "task_config.pkl"
    if not task_config_path.exists():
        msg = "task_config.pkl 不存在"
        print(f"[ERROR] {msg}")
        results["errors"].append(msg)
        return results
    
    print(f"\n[CHECK] 加载 task 配置...")
    try:
        with open(task_config_path, "rb") as f:
            task_config = pickle.load(f)
        print(f"  配置键: {list(task_config.keys())}")
        results["checks"].append({
            "name": "task_config_keys",
            "value": list(task_config.keys())
        })
    except Exception as e:
        msg = f"加载 task 配置失败: {e}"
        print(f"[ERROR] {msg}")
        results["errors"].append(msg)
        return results
    
    if "dataset" not in task_config:
        msg = "task 配置中没有 dataset 键"
        print(f"[ERROR] {msg}")
        results["errors"].append(msg)
        return results
    
    dataset_config = task_config["dataset"]
    print(f"\n[CHECK] 数据集配置:")
    print(f"  class: {dataset_config.get('class')}")
    print(f"  module_path: {dataset_config.get('module_path')}")
    
    if provider_uri:
        print(f"\n[CHECK] 初始化 QLib...")
        try:
            import qlib
            from qlib.config import REG_CN
            qlib.init(provider_uri=provider_uri, region=REG_CN)
            print("  QLib 初始化成功")
        except Exception as e:
            msg = f"QLib 初始化失败: {e}"
            print(f"[ERROR] {msg}")
            results["errors"].append(msg)
            return results
    
    print(f"\n[CHECK] 使用配置重建数据集...")
    try:
        from qlib.utils import init_instance_by_config
        from qlib.data.dataset import DatasetH
        
        dataset = init_instance_by_config(dataset_config, accept_types=DatasetH)
        print(f"  数据集类型: {type(dataset).__name__}")
        results["checks"].append({
            "name": "rebuilt_dataset_type",
            "value": type(dataset).__name__
        })
        
        if hasattr(dataset, "segments"):
            print(f"  Segments: {list(dataset.segments.keys())}")
            results["checks"].append({
                "name": "rebuilt_segments",
                "value": list(dataset.segments.keys())
            })
    except Exception as e:
        msg = f"重建数据集失败: {e}"
        print(f"[ERROR] {msg}")
        results["errors"].append(msg)
        import traceback
        traceback.print_exc()
        return results
    
    print(f"\n[CHECK] 测试 prepare 方法...")
    from qlib.data.dataset.handler import DataHandlerLP
    
    for segment in ["test", "valid", "train"]:
        if not hasattr(dataset, "segments") or segment not in dataset.segments:
            continue
            
        print(f"\n  Segment: {segment}")
        
        for data_key, key_name in [
            (DataHandlerLP.DK_L, "learn"),
            (DataHandlerLP.DK_I, "infer"),
            (DataHandlerLP.DK_R, "raw"),
        ]:
            try:
                X = dataset.prepare(segment, col_set="feature", data_key=data_key)
                if X is not None and not X.empty:
                    print(f"    {key_name}: 成功, shape={X.shape}")
                    results["checks"].append({
                        "name": f"rebuilt_prepare_{segment}_{key_name}",
                        "status": "success",
                        "shape": X.shape
                    })
                    break
            except Exception as e:
                print(f"    {key_name}: {type(e).__name__} - {e}")
    
    print("\n" + "=" * 60)
    print("诊断完成")
    print("=" * 60)
    
    return results


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="SHAP 数据集诊断工具")
    parser.add_argument("run_path", help="MLflow run 目录路径")
    parser.add_argument("--provider-uri", help="QLib 数据目录", default=None)
    parser.add_argument("--with-task-config", action="store_true", help="使用 task 配置重建数据集")
    
    args = parser.parse_args()
    
    print(f"Run 路径: {args.run_path}")
    
    results = diagnose_dataset(args.run_path)
    
    if args.with_task_config and args.provider_uri:
        print("\n")
        results2 = diagnose_shap_with_task_config(args.run_path, args.provider_uri)
