# ADR 0062：验收检查依赖文件 fencing

标准 controller 在 Agent 执行前记录检查命令中位于候选 workspace 内的文件 digest；Agent 返回后再次计算。若检查脚本或测试依赖文件被修改，控制器拒绝使用旧验收结果并将工作项按既有失败语义处理；普通功能文件仍可修改。无法解析为 workspace 内文件的 flags、inline scripts 和外部命令参数不臆测为依赖。
