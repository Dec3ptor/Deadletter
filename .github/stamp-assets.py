# Append the commit SHA to local script and stylesheet URLs, so a browser can
# never mix a cached copy of one file with a fresh copy of another. Only bare
# filenames are touched; CDN and font URLs contain "/" and are left alone.
import re, sys, pathlib
version = sys.argv[1][:8]
pattern = re.compile(r'((?:src|href)=")([A-Za-z0-9_.\-]+\.(?:js|css))(")')
for path in sorted(pathlib.Path('.').glob('*.html')):
    text = path.read_text(encoding='utf-8')
    hits = len(pattern.findall(text))
    stamped = pattern.sub(lambda m: m.group(1) + m.group(2) + '?v=' + version + m.group(3), text)
    if stamped != text:
        path.write_text(stamped, encoding='utf-8')
        print('stamped %s (%d refs)' % (path, hits))
