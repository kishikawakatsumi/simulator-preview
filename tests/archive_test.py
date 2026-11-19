import importlib.util, io, plistlib, tarfile, tempfile, unittest, zipfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('unpack', Path(__file__).resolve().parents[1] / 'scripts/unpack-preview.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
class ArchiveTests(unittest.TestCase):
    def archive(self, path, extra=None):
        data=io.BytesIO()
        with tarfile.open(fileobj=data, mode='w') as t:
            root=tarfile.TarInfo('App.app'); root.type=tarfile.DIRTYPE; t.addfile(root)
            for name, body, mode in [
                ('App.app/Info.plist', plistlib.dumps({'CFBundleIdentifier':'com.example.demo','CFBundleExecutable':'Demo','CFBundleSupportedPlatforms':['iPhoneSimulator'],'MinimumOSVersion':'18.0'}), 0o644),
                ('App.app/Demo', b'executable', 0o755),
            ]:
                item=tarfile.TarInfo(name); item.size=len(body); item.mode=mode; t.addfile(item,io.BytesIO(body))
            if extra: extra(t)
        with zipfile.ZipFile(path,'w') as z: z.writestr('app.tar',data.getvalue())
    def test_valid_app_preserves_executable(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d); self.archive(p/'a.zip'); info=module.unpack(p/'a.zip',p/'out')
            self.assertEqual(info['bundleID'],'com.example.demo'); self.assertTrue((p/'out/App.app/Demo').stat().st_mode & 0o111)
    def test_malicious_entries(self):
        def regular(t,name):
            entry=tarfile.TarInfo(name); entry.size=1; t.addfile(entry,io.BytesIO(b'x'))
        def link(t,name,target):
            entry=tarfile.TarInfo(name); entry.type=tarfile.SYMTYPE; entry.linkname=target; t.addfile(entry)
        cases=[lambda t:regular(t,'../escape'),lambda t:regular(t,'/tmp/escape'),lambda t:regular(t,'App.app/Demo'),lambda t:link(t,'App.app/link','../../outside'),lambda t:(link(t,'App.app/link','Demo'),regular(t,'App.app/link/escape'))]
        for extra in cases:
            with self.subTest(extra=extra), tempfile.TemporaryDirectory() as d:
                p=Path(d); self.archive(p/'a.zip',extra)
                with self.assertRaises((ValueError,FileNotFoundError)): module.unpack(p/'a.zip',p/'out')
                self.assertFalse((p/'escape').exists())
    def test_internal_symlink(self):
        def extra(t):
            entry=tarfile.TarInfo('App.app/link'); entry.type=tarfile.SYMTYPE; entry.linkname='Demo'; t.addfile(entry)
        with tempfile.TemporaryDirectory() as d:
            p=Path(d); self.archive(p/'a.zip',extra); module.unpack(p/'a.zip',p/'out')
            self.assertEqual((p/'out/App.app/link').read_bytes(),b'executable')
if __name__=='__main__': unittest.main()
