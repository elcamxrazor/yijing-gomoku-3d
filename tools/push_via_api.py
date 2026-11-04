"""git push 被网络挡住时的兜底：走 api.github.com 的 Git Data API，
把本地 HEAD 这一笔提交**原样**同步到远端 main。

适用场景（2026-11-05 实测）：本机直连 github.com:443 超时，环境代理对
github.com 的 CONNECT 返回 502，但 api.github.com 通。于是 git over HTTPS
推不上去，Git Data API 可以。blob / tree / commit 三层都会与本地 SHA 比对，
任何一层不一致就中止，不会把不一致的历史写进远端。

用法（在仓库任意目录）：
    python tools/push_via_api.py

前提：remote.origin.url 里带 x-access-token（本仓库已配好）；远端 main
正好是本地 HEAD 的父节点（干净 fast-forward）；只有一笔未推送提交。
多个提交 / 历史分叉请先在会话里处理，不要盲目跑这个脚本。
"""
import base64
import json
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = subprocess.check_output(
    ['git', 'rev-parse', '--show-toplevel'], text=True).strip()


def git(*args, text=True):
    result = subprocess.check_output(['git', *args], cwd=ROOT)
    return result.decode('utf-8').strip() if text else result


def main():
    remote_url = git('config', '--get', 'remote.origin.url')
    match = re.search(
        r'https://x-access-token:([^@]+)@github\.com/([^/]+)/([^/\s]+?)(?:\.git)?$',
        remote_url)
    if not match:
        sys.exit('无法从 remote.origin.url 解析 token / 仓库名')
    token, owner, repo = match.group(1), match.group(2), match.group(3)
    base = f'/repos/{owner}/{repo}'

    def api(path, method='GET', data=None):
        request = urllib.request.Request(
            'https://api.github.com' + path,
            data=json.dumps(data, ensure_ascii=False).encode('utf-8') if data is not None else None,
            method=method,
            headers={
                'Authorization': 'Bearer ' + token,
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json; charset=utf-8',
                'User-Agent': 'yijing-push/1.0',
            })
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode('utf-8'))

    remote_head = api(base + '/git/ref/heads/main')['object']['sha']
    local_head = git('rev-parse', 'HEAD')
    local_parent = git('rev-parse', 'HEAD^')
    print('remote main :', remote_head)
    print('local  HEAD :', local_head, ' parent:', local_parent)
    if remote_head == local_head:
        print('远端已是最新，无需推送')
        return
    if remote_head != local_parent:
        sys.exit('远端 main 不是本地 HEAD 的父节点：存在分叉或多笔未推送提交，请先处理')

    raw = git('cat-file', '-p', 'HEAD', text=False)
    header, message = raw.split(b'\n\n', 1)
    headers = header.decode('utf-8').splitlines()
    local_tree = next(line.split(' ', 1)[1] for line in headers if line.startswith('tree '))
    author_line = next(line for line in headers if line.startswith('author '))
    committer_line = next(line for line in headers if line.startswith('committer '))

    def parse_identity(line):
        # author Name <email> 1793811381 +0800
        parsed = re.match(r'\w+ (.+) <([^>]+)> (\d+) ([+-]\d{4})$', line)
        if not parsed:
            sys.exit('无法解析身份行：' + line)
        name, email, timestamp, offset = parsed.groups()
        sign = 1 if offset[0] == '+' else -1
        delta = timedelta(hours=int(offset[1:3]), minutes=int(offset[3:5])) * sign
        return {
            'name': name,
            'email': email,
            'date': datetime.fromtimestamp(int(timestamp), timezone(delta)).isoformat(),
        }

    entries = []
    for line in git('diff', '--name-status', 'HEAD^', 'HEAD').splitlines():
        status, path = line.split('\t', 1)
        if status.startswith('R'):
            sys.exit('暂不支持重命名，请先手工处理：' + line)
        if status not in ('M', 'A', 'D'):
            sys.exit('暂不支持的状态：' + line)
        if status == 'D':
            old_mode = git('ls-tree', 'HEAD^', '--', path).split()[0]
            entries.append({'path': path, 'mode': old_mode, 'type': 'blob', 'sha': None})
            print(f'  delete {path}')
            continue
        mode = git('ls-tree', 'HEAD', '--', path).split()[0]
        content = subprocess.check_output(['git', 'cat-file', 'blob', 'HEAD:' + path], cwd=ROOT)
        expected = git('rev-parse', 'HEAD:' + path)
        blob = api(base + '/git/blobs', 'POST', {
            'content': base64.b64encode(content).decode('ascii'),
            'encoding': 'base64',
        })
        if blob['sha'] != expected:
            sys.exit(f'blob SHA 不一致：{path} 本地 {expected[:8]} / 远端 {blob["sha"][:8]}')
        print(f'  blob   {path:<44} {blob["sha"][:8]} OK')
        entries.append({'path': path, 'mode': mode, 'type': 'blob', 'sha': blob['sha']})

    parent_raw = git('cat-file', '-p', 'HEAD^', text=False).decode('utf-8')
    parent_tree = next(line.split(' ', 1)[1] for line in parent_raw.splitlines()
                       if line.startswith('tree '))
    tree = api(base + '/git/trees', 'POST', {'base_tree': parent_tree, 'tree': entries})
    if tree['sha'] != local_tree:
        sys.exit(f'tree SHA 不一致：本地 {local_tree[:8]} / 远端 {tree["sha"][:8]}')
    print('  tree   local', local_tree[:8], ' remote', tree['sha'][:8], 'OK')

    commit = api(base + '/git/commits', 'POST', {
        'message': message.decode('utf-8'),
        'tree': tree['sha'],
        'parents': [remote_head],
        'author': parse_identity(author_line),
        'committer': parse_identity(committer_line),
    })
    identical = commit['sha'] == local_head
    print('  commit local', local_head[:8], ' remote', commit['sha'][:8],
          'IDENTICAL' if identical else 'SHA 不同（tree 与内容一致）')

    api(base + '/git/refs/heads/main', 'PATCH', {'sha': commit['sha'], 'force': False})
    final = api(base + '/git/ref/heads/main')['object']['sha']
    if final != commit['sha']:
        sys.exit('远端 ref 未更新到目标 commit')
    # 让本地跟踪引用跟上，git status 不再误报 ahead。
    subprocess.run(['git', 'update-ref', 'refs/remotes/origin/main', final], cwd=ROOT, check=True)
    print('PUSH_OK  remote main =', final)
    if not identical:
        print('注意：远端 commit SHA 与本地不同，请用 git reset --hard', final, '对齐本地分支')


if __name__ == '__main__':
    main()
