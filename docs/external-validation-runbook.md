# 外部验收 Runbook

本文只描述需要在本地 fake 适配器之外执行的验收。当前工作区的静态 workflow、`pnpm ci:local` 和 183/183 本地测试不能替代额外 hosted runner、托管 PR/CI、真实远程主机、容器 daemon、VM 或生产 metrics 的运行证据；181/181 是 ADR0069 的历史基线。任何阶段都不得把凭据写入日志、截图、artifact 或仓库。

## 1. GitHub Actions hosted run

只读 preflight：确认目标 commit、workflow 文件和 lockfile 已发布，检查 Actions 页面是否能看到对应 push/pull request run。用户授权边界：用户自行登录 GitHub 并授权查看仓库 Actions；本 runbook 不请求或保存任何访问凭据。

可执行只读模板（将尖括号占位符替换为当前仓库/提交；不要把 token 写入命令）：

```sh
gh workflow view .github/workflows/ci.yml --repo <OWNER>/<REPO>
gh run list --repo <OWNER>/<REPO> --commit <COMMIT_SHA> --limit 5
gh run view <RUN_ID> --repo <OWNER>/<REPO> --json databaseId,headSha,status,conclusion,jobs
```

成功证据：hosted run 的 commit SHA、job 名称、开始/结束时间和每个 gate 的成功状态；下载的日志需先脱敏。失败/停止：workflow 未触发、SHA 不匹配、依赖安装非 frozen、任一 gate failed/skipped/timeout，立即停止后续外部交付。

已记录的 hosted 证据：[`run 37404982889`](https://github.com/aircrushin/autonomous-dev/actions/runs/37404982889) 的 `verify` job 对 commit `0f876c29a4f537e9cad58a8886f5610b6f8336e9` 成功执行 frozen install 与 `pnpm ci:local`。该证据仅证明这次 hosted workflow 运行；尚无 PR/merge 对账，也未验收 SSH、容器 daemon、VM、跨机 Agent 或生产 metrics。

## 2. PR、CI 与 merge 对账

只读 preflight：确认候选 revision、目标分支当前 revision、PR head 和本地 Evidence candidate digest 一致；读取 provider Operation 回执与 CI 状态。用户授权边界：创建 PR、push、merge 必须由用户明确授权，且使用最小范围的托管凭据。

可执行只读模板：

```sh
gh pr view <PR_NUMBER> --repo <OWNER>/<REPO> --json number,state,headRefOid,baseRefName,statusCheckRollup
gh api repos/<OWNER>/<REPO>/commits/<COMMIT_SHA>/check-runs --method GET
```

成功证据：push/PR/CI/merge 的 provider 回执、exact revision、幂等键和 SQLite Operation 状态可互相对账。失败/停止：回执缺失、revision 漂移、CI 非最终 PASS、merge 状态不成功或发现重复副作用，停止并保留 DELIVERING/WAITING_EXTERNAL 状态。

## 3. SSH 远程主机

只读 preflight：验证主机、端口、工作区根目录和工具版本；先执行无副作用的 `pwd`、`git --version` 和权限检查。用户授权边界：用户提供临时、最小权限的 SSH 连接方式；不得把私钥或环境凭据写入命令、日志或 artifact。

可执行只读模板（`<SSH_TARGET>` 和 `<REMOTE_WORKSPACE>` 仅为占位符）：

```sh
ssh -- <SSH_TARGET> 'pwd && git --version && test -r <REMOTE_WORKSPACE> && test -x <REMOTE_WORKSPACE>'
```

成功证据：远端 workspace create/snapshot/destroy 回执、命令 argv/cwd、超时和输出上限证据，以及远端 revision 与候选 digest 对账。失败/停止：主机身份不明、cwd 越界、传输错误、超时、输出超限或清理所有权不明，停止并销毁自有 workspace。

## 4. Docker/Podman daemon 与镜像供应链

只读 preflight：确认 daemon socket、运行时版本、镜像 digest、签名/来源和网络策略；只读取镜像元数据，不启动业务容器。用户授权边界：用户明确授权访问本机 daemon 和指定镜像来源；不得自动拉取未审查镜像。

可执行只读模板（不启动、拉取或删除容器）：

```sh
docker version --format '{{json .Server}}'
docker image inspect <IMAGE_REF> --format '{{json .RepoDigests}}'
podman version --format '{{json .Server}}'
podman image inspect <IMAGE_REF> --format '{{json .RepoDigests}}'
```

成功证据：固定 `--rm`、`--init`、`--network none`、workspace mount、镜像 digest、容器退出回执和清理记录。失败/停止：daemon 不可用、digest 漂移、网络隔离失效、mount 越界或容器残留，停止并清理。

## 5. VM 与跨机 Agent

只读 preflight：确认 VM/节点身份、镜像版本、时钟、网络和控制器版本；检查跨机 SQLite/队列连接仅限健康读取。用户授权边界：用户授权节点访问和进程管理窗口；不得自动扩容、部署或修改生产配置。

可执行只读模板（由用户提供只读节点 CLI；不执行 apply/deploy/scale）：

```sh
<VM_CLI> node describe <NODE_ID> --output json
<VM_CLI> instance get <INSTANCE_ID> --output json
```

成功证据：跨机 lease fencing、Attempt 恢复、agent 不重复执行、消息/回执 correlation id、节点日志脱敏副本。失败/停止：节点身份或版本不一致、lease fencing 失败、重复副作用、网络分区或进程管理器无法回收，停止并转人工恢复。

## 6. Metrics 认证、TLS 与生产只读验收

只读 preflight：验证证书链、TLS 最低版本、endpoint scope、调用方授权钩子和时间窗口；只读取 dashboard/Prometheus endpoint。用户授权边界：用户提供短时、只读访问授权；凭据只存在于受控运行环境，不写入命令或记录。

可执行只读模板（`<READ_ONLY_ENDPOINT>` 为 HTTPS URL；授权由受控环境注入，不写入 shell history）：

```sh
curl --fail-with-body --silent --show-error --head <READ_ONLY_ENDPOINT>/health
curl --fail-with-body --silent --show-error <READ_ONLY_ENDPOINT>/metrics
```

成功证据：TLS/认证握手结果、HTTP 状态、授权拒绝样例、稳定 metrics labels、时间戳和脱敏响应摘要。失败/停止：证书错误、未授权访问被放行、跨租户数据泄漏、指标来源不明或远端写入迹象，立即停止并撤销临时授权。
