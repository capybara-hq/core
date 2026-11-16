/** Fixed private descriptor service. No user code or arbitrary RPC-selected paths are accepted. */
export const OUTPUT_SPOOL_HELPER = String.raw`
import os,sys,json,stat,base64
fds={}; dirs=[]; spool_parent=None; spool_name=None; expected=None; io={}; written=0; anchors=[]; finals=[]

def identity(fd):
    s=os.fstat(fd)
    if s.st_dev>9007199254740991 or s.st_ino>9007199254740991: raise ValueError('Unsafe output identity')
    if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid(): raise ValueError('Invalid owned output identity')
    return {'dev':s.st_dev,'ino':s.st_ino,'uid':s.st_uid}

def components(path):
    if not isinstance(path,str) or not path.startswith('/') or '\\' in path or '\x00' in path: raise ValueError('Invalid private path')
    if path=='/': return []
    parts=path.split('/')[1:]
    if any(p in ('','.','..') for p in parts): raise ValueError('Invalid private component')
    return parts

def walk(path,create=False):
    fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
    try:
        for name in components(path):
            try: child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            except FileNotFoundError:
                if not create: raise
                os.mkdir(name,0o700,dir_fd=fd)
                child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                dirs.append(os.dup(fd))
            os.close(fd);fd=child
        return fd
    except:
        os.close(fd);raise

def descend(root,parts,create):
    fd=os.dup(root)
    try:
        for name in parts:
            try: child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            except FileNotFoundError:
                if not create: raise
                os.mkdir(name,0o700,dir_fd=fd)
                child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                dirs.append(os.dup(fd))
            os.close(fd);fd=child
        return fd
    except:
        os.close(fd);raise

def write_all(fd,data,offset):
    global written
    while data:
        if written>=io.get('failWriteAfterBytes',float('inf')): raise OSError(28,'Injected ENOSPC')
        n=os.pwrite(fd,data[:io.get('maxWriteBytes',65536)],offset)
        written+=n
        if n<=0: raise OSError('Output write made no progress')
        offset+=n;data=data[n:]

def run(m):
    global spool_parent,spool_name,expected,io
    op=m['op']
    if op=='init':
        io=m.get('io') or {}
        root=walk(m['root']); spool_name=m['name']
        root_stat=os.fstat(root)
        if root_stat.st_uid!=os.getuid() or root_stat.st_mode&0o077: raise ValueError('Private spool root must be owner controlled')
        if '/' in spool_name or spool_name in ('','.','..'): raise ValueError('Invalid private locator')
        root_identity={'dev':root_stat.st_dev,'ino':root_stat.st_ino,'uid':root_stat.st_uid}
        if m.get('existing') and root_identity!=m['directory']: raise ValueError('Private root identity changed')
        anchors.append((m['root'],os.dup(root)))
        spool_parent=root
        flags=os.O_RDWR|os.O_NOFOLLOW
        if not m.get('existing'): flags|=os.O_CREAT|os.O_EXCL
        try: fds['spool']=os.open(spool_name,flags,0o600,dir_fd=root)
        except FileNotFoundError:
            if m.get('existing') and m.get('cleanup'): expected=m['identity']; return {'identity':expected,'directory':root_identity,'directories':0}
            raise
        expected=identity(fds['spool'])
        if os.fstat(fds['spool']).st_mode&0o077: raise ValueError('Private spool permissions changed')
        if m.get('existing'):
            if expected!=m['identity'] or os.fstat(fds['spool']).st_size<m['committed']: raise ValueError('Retained output identity or length lost')
            return {'identity':expected,'directory':root_identity,'directories':0}
        dirs.append(os.dup(root))
        finals.append((root,spool_name,expected))
        artifact_root=walk(m['artifactRoot'])
        anchors.append((m['artifactRoot'],os.dup(artifact_root)))
        try:
            parts=m['artifactComponents']
            if not parts or any(not isinstance(p,str) or p in ('','.','..') or '/' in p or '\\' in p for p in parts): raise ValueError('Invalid artifact components')
            parent=descend(artifact_root,parts[:-1],True)
            try:
                fds['artifact']=os.open(parts[-1],os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
                artifact_identity=identity(fds['artifact'])
                finals.append((os.dup(parent),parts[-1],artifact_identity))
                if artifact_identity==expected: raise ValueError('Output artifacts must be separate')
                dirs.append(os.dup(parent))
                anchors.append((os.path.join(m['artifactRoot'],*parts[:-1]),os.dup(parent)))
            finally: os.close(parent)
        finally: os.close(artifact_root)
        return {'identity':expected,'directory':root_identity,'directories':len(dirs)}
    if op=='verify':
        for parent,name,wanted in finals:
            s=os.stat(name,dir_fd=parent,follow_symlinks=False)
            if not stat.S_ISREG(s.st_mode) or {'dev':s.st_dev,'ino':s.st_ino,'uid':s.st_uid}!=wanted: raise ValueError('Output file changed during setup')
        for path,fd in anchors:
            current=walk(path)
            try:
                a=os.fstat(current);b=os.fstat(fd)
                if (a.st_dev,a.st_ino)!=(b.st_dev,b.st_ino): raise ValueError('Output ancestor changed during setup')
            finally: os.close(current)
        return None
    if op=='sync':
        os.fsync(fds[m['file']]);return None
    if op=='syncDir':
        os.fsync(dirs[m['index']]);return None
    if op=='write':
        write_all(fds[m['file']],base64.b64decode(m['data'],validate=True),m['offset']);return None
    if op=='read':
        fd=fds['spool']
        if identity(fd)!=expected or os.fstat(fd).st_size<m['total']: raise ValueError('Retained output is short')
        parts=[];left=m['length'];offset=m['offset']
        while left:
            data=b'' if offset>=io.get('shortReadAfterBytes',float('inf')) else os.pread(fd,min(left,io.get('maxReadBytes',65536)),offset)
            if not data: raise ValueError('Unexpected short retained output read')
            parts.append(data);left-=len(data);offset+=len(data)
        return base64.b64encode(b''.join(parts)).decode('ascii')
    if op=='unlink':
        try:
            s=os.stat(spool_name,dir_fd=spool_parent,follow_symlinks=False)
            if not stat.S_ISREG(s.st_mode) or {'dev':s.st_dev,'ino':s.st_ino,'uid':s.st_uid}!=expected: raise ValueError('Private spool replacement refused')
            os.unlink(spool_name,dir_fd=spool_parent)
        except FileNotFoundError: pass
        return None
    if op=='syncParent': os.fsync(spool_parent);return None
    raise ValueError('Unknown private output operation')

for line in sys.stdin:
    try:
        m=json.loads(line)
        if m['op']=='close': break
        result=run(m)
        print(json.dumps({'result':result}),flush=True)
    except Exception as e:
        print(json.dumps({'error':getattr(e,'errno',None) or str(e)}),flush=True)
for fd in set(list(fds.values())+dirs+[fd for _,fd in anchors]+[fd for fd,_,_ in finals]+([spool_parent] if spool_parent is not None else [])):
    try: os.close(fd)
    except OSError: pass
`;
