# CodeGraph 源码指纹增强系统

## 项目概述

基于 Source Insight 预编译索引架构思想，为 CodeGraph 代码知识图谱实现了三层增量索引系统。

通过 CRC32 文件指纹比对、头文件依赖传播、以及符号级增量计算，将大规模 C++ 项目的增量索引效率提升 359 倍。

## 三层架构



## 性能对标 Source Insight

Kerogen C++ (2,818 / 15,053 include)

| 指标 | Source Insight | CodeGraph+L3 |
|------|---------------|--------------|
| 文件指纹 | <1ms/ | 0.00ms/ |
| 头文件传播 | <1ms | 0.03ms/ |
| 跳过率 | ~90% | 100.0% |
| 首轮 | - | 5.5s |
| 稳态 | - | 6.3s |

## 关键优化

| 优化 | 前 | 后 | 倍数 |
|------|-----|-----|------|
| Fan-out | 28,087ms | 78ms | 359x |
| INSERT | 1ms/ | 94ms/ | 30x |
| existsSync | 27s | 25ms | 1080x |

## Kerogen Top-5

| 头文件 | 引用 | 风险 |
|--------|------|------|
| keglobal.h | 404 | |
| kedata_global.h | 144 | |
| kewell.h | 142 | |
| dlgwarning.h | 135 | |
| keobject.h | 121 | |

## 文件



## 测试

20/20 : 9 fingerprint + 11 db-perf

## 

- CodeGraph: https://github.com/colbymchenry/codegraph
