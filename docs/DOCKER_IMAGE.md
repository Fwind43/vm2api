# Fork 镜像构建与部署

本分叉：<https://github.com/Fwind43/vm2api>。镜像：`ghcr.io/fwind43/vm2api`，包含 Clash 订阅导入。

## 一键打包

1. 打开 [Build and publish Docker image](https://github.com/Fwind43/vm2api/actions/workflows/docker-image.yml)。
2. 点击 **Run workflow**，选择 `main`，`image_tag` 保持 `latest`，再次点击 **Run workflow**。
3. 等待两个架构构建和启动检查通过。最后的发布任务才会更新指定标签，同时生成 `sha-<12 位提交号>` 标签。

默认同时构建 `linux/amd64`、`linux/arm64`，Docker 会按服务器架构选择镜像。ARM64 的控制面原生运行，槽位仍使用上游固定的 AMD64 payload，并通过 QEMU 兼容。使用内置 `GITHUB_TOKEN` 发布到 GHCR，**无需配置 Docker Hub 密码或 PAT**。此独立工作流不会创建 GitHub Release，也不需要先发布上游二进制；Docker 构建会从 `deploy/payload.json` 指定的上游 Release 下载并校验 payload。

命令行也可触发：

```sh
gh workflow run docker-image.yml --repo Fwind43/vm2api --ref main -f image_tag=latest
```

构建结果的 Summary 包含镜像标签、提交标签及 manifest digest。重要部署建议固定提交标签或 digest，而不是长期跟随 `latest`。

## Linux Docker Compose 部署

先安装 Docker Engine 和 Compose 插件。下面的操作在**部署服务器**执行，不会在服务器本地编译：

```sh
git clone https://github.com/Fwind43/vm2api.git
cd vm2api
cp .env.example .env
# 编辑 .env，至少设置 VM2API_ADMIN_PASSWORD 和 DB_SECRET。
# 可使用 openssl rand -hex 32 生成随机值；不要提交 .env。
# 确保 .env 没有重复设置下面的镜像变量，然后加入：
printf '\nVM2API_IMAGE=ghcr.io/fwind43/vm2api\nVM2API_IMAGE_TAG=latest\n' >> .env
docker compose pull
docker compose up -d
curl --fail http://127.0.0.1:8787/healthz
```

管理台：`http://服务器地址:8787/console/`。对公网使用时，先配置防火墙、HTTPS 或 SSH 隧道，不要裸露 Docker socket。此项目将 Docker socket 挂入控制面以管理槽位，应仅在可信服务器运行。完整环境配置见 [DEPLOY.md](DEPLOY.md)。

ARM64 部署也使用上面的基础 Compose 和多架构镜像，**不要叠加**面向本地构建的 `docker-compose.arm64.yml`。

更新：

```sh
git pull --ff-only
docker compose pull
docker compose up -d
```

回滚时，将 `.env` 中 `VM2API_IMAGE_TAG` 改成已知的 `sha-<提交号>`，再执行 `pull` 和 `up -d`。数据目录保持不变，但升级前仍应备份持久化目录。

## 可选：启用 Clash / Mihomo

按 [CLASH.md](CLASH.md) 配置 `VM2API_CLASH_CONTROLLER`、随机 `VM2API_CLASH_SECRET` 并初始化 sidecar。后续使用：

```sh
docker compose -f docker-compose.yml -f docker-compose.clash.yml pull
docker compose -f docker-compose.yml -f docker-compose.clash.yml up -d
```

此 overlay 使用 Linux host networking，确认端口未被其他服务占用。

## GHCR 首次发布可见性

GitHub 的新容器包默认可能是 private。仓库所有者可在 [容器包设置](https://github.com/users/Fwind43/packages/container/vm2api/settings) 将 Visibility 改为 **Public**，这样部署服务器就能匿名拉取。若有意保留私有镜像，应使用具备 `read:packages` 权限的 token 在部署服务器登录 `ghcr.io`；不要把 token 写进仓库或 Compose。
