// 测试 TurnEventAccumulator 是否正确构建嵌套子智能体事件
// (源码是 .ts，用 tsx/esbuild 不便；直接模拟 consume 逻辑验证数据结构)
// 这里通过 vite 的 esbuild 转译
import { build } from 'vite';
