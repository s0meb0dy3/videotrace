# 提交

```bash
# 在仓库根目录执行：暂存所有新增 / 修改 / 删除
git add -A
git commit -m "说明这次改了什么"
git push -u origin simplify
```

# 说明
- 远程名是 `origin`（不是 orgin）。可用 `git remote -v` 查看。
- `git add -A` = 全仓库改动；`git add .` 只在当前目录生效。
- `-u` 只在第一次推送该分支时需要，作用是记住上游，之后直接 `git push` 即可。
```
