#!/usr/bin/env python3
"""Package the browser game as an Itch.io HTML game ZIP."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / 'dist' / 'mana-surge-itch.zip'
INCLUDED_PATHS = (Path('index.html'), Path('assets'), Path('src'))
REQUIRED_FILES = (
    Path('index.html'),
    Path('assets/scripts/phaser.min.js'),
    Path('assets/styles/main.css'),
    Path('assets/music/bgm.mp3'),
    Path('src/main.js'),
)


def iter_files():
    files = []
    for included_path in INCLUDED_PATHS:
        path = ROOT / included_path
        if path.is_file():
            files.append(path)
        elif path.is_dir():
            files.extend(candidate for candidate in path.rglob('*') if candidate.is_file())
        else:
            raise FileNotFoundError(f'Required game path is missing: {included_path}')
    return sorted(files, key=lambda path: path.relative_to(ROOT).as_posix())


def main():
    for required_file in REQUIRED_FILES:
        if not (ROOT / required_file).is_file():
            raise FileNotFoundError(f'Required game file is missing: {required_file}')

    files = iter_files()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(OUTPUT, 'w', compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            archive_name = path.relative_to(ROOT).as_posix()
            info = ZipInfo(archive_name, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes(), compress_type=ZIP_DEFLATED, compresslevel=9)

    print(f'Created {OUTPUT.relative_to(ROOT)} ({len(files)} files)')


if __name__ == '__main__':
    main()
