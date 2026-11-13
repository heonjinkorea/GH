#!/usr/bin/env python3
"""업무편람 HWP/PDF → 웹사이트 데이터(site/data/manual.json, site/pages/*.webp) 변환.

사용법:
    python scripts/build.py                 # base/ 폴더의 최신 .hwp / .pdf 사용
    python scripts/build.py --xml doc.xml   # 이미 변환한 hwp5proc XML 재사용(빠름)
    python scripts/build.py --no-pages      # 원문 페이지 이미지 생성 생략

필요 패키지: pip install pyhwp pymupdf pillow
"""
import argparse
import html
import json
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / "base"
SITE = ROOT / "site"

# HWP 문서 스타일 번호(문서의 스타일 목록 기준)
ST_PART, ST_CHAPTER, ST_SECTION, ST_SUB = "1", "2", "3", "4"
ST_L1, ST_L2, ST_L3 = "5", "6", "7"           # ■, -, •
ST_TBL_POS, ST_TBL_BODY, ST_TBL_TITLE, ST_TBL_NOTE, ST_LAW = "8", "9", "10", "11", "12"

SKIP_TAGS = {"Header", "Footer", "MemoList", "PageHide", "FootnoteShape",
             "PageBorderFill", "PageDef", "ColumnsDef"}


def seg_items(p):
    """문단의 인라인 요소를 순서대로(메모 필드 안의 글자도 펼쳐서) 돌려줌."""
    for seg in p.findall("LineSeg"):
        for c in seg:
            if c.tag == "FieldUnknown":
                yield from c
            else:
                yield c


def esc(s):
    return html.escape(s, quote=False)


def latest(pattern):
    """base/에서 파일명의 버전(v41 등)·날짜가 가장 큰 파일. (git은 수정시각을 보존하지 않음)"""
    def key(p):
        v = re.search(r"v(\d+)", p.name)
        d = re.search(r"(\d{6,8})", p.name)
        return (int(v.group(1)) if v else -1, d.group(1) if d else "", p.name)
    files = sorted(BASE.glob(pattern), key=key)
    return files[-1] if files else None


# ---------------------------------------------------------------- HWP → XML
def hwp_to_xml(hwp: Path) -> Path:
    out = Path(tempfile.gettempdir()) / "manual_hwp.xml"
    exe = Path(sys.executable).with_name("hwp5proc")
    cmd = [str(exe) if exe.exists() else "hwp5proc", "xml", str(hwp)]
    print("HWP 변환 중 (수 분 걸릴 수 있음):", hwp.name, flush=True)
    with open(out, "wb") as f:
        subprocess.run(cmd, stdout=f, stderr=subprocess.DEVNULL, check=True)
    return out


# ---------------------------------------------------------------- 렌더링
class Renderer:
    """HWP XML 문단 → HTML 블록 + 검색용 평문."""

    def para_text(self, p):
        """문단의 인라인 텍스트만(표/도형 제외)."""
        buf = []
        for c in seg_items(p):
                if c.tag == "Text":
                    buf.append(c.text or "")
                elif c.tag == "ControlChar" and c.get("name") == "TAB":
                    buf.append(" ")
                elif c.tag == "ControlChar" and c.get("name") == "LINE_BREAK":
                    buf.append("\n")
        return re.sub(r"[  ]+", " ", "".join(buf)).strip()

    def render_par(self, p, html_out, text_out, in_cell=False):
        st = p.get("style-id")
        inline = []

        def flush():
            t = re.sub(r"[  ]+", " ", "".join(inline)).strip()
            inline.clear()
            if not t or t in ("❘", "|"):
                return
            text_out.append(t)
            h = esc(t).replace("\n", "<br>")
            if in_cell:
                cls = {ST_L1: "l1", ST_L2: "l2", ST_L3: "l3"}.get(st, "")
                html_out.append(f'<div class="{cls}">{h}</div>' if cls else f"<div>{h}</div>")
                return
            if st == ST_SUB:
                html_out.append(f"<h4>{h}</h4>")
            elif st == ST_L1:
                html_out.append(f'<p class="l1">{h}</p>')
            elif st == ST_L2:
                html_out.append(f'<p class="l2">{h}</p>')
            elif st == ST_L3:
                html_out.append(f'<p class="l3">{h}</p>')
            elif st == ST_TBL_TITLE or (st == ST_TBL_POS and t.startswith("[")):
                html_out.append(f'<p class="cap">{h}</p>')
            elif st == ST_TBL_NOTE:
                html_out.append(f'<p class="note">{h}</p>')
            elif st == ST_LAW:
                html_out.append(f'<p class="law">{h}</p>')
            else:
                html_out.append(f"<p>{h}</p>")

        for c in seg_items(p):
                if c.tag == "Text":
                    inline.append(c.text or "")
                elif c.tag == "ControlChar":
                    n = c.get("name")
                    if n == "TAB":
                        inline.append(" ")
                    elif n == "LINE_BREAK":
                        inline.append("\n")
                elif c.tag == "TableControl":
                    flush()
                    self.render_table(c, html_out, text_out)
                elif c.tag == "GShapeObjectControl":
                    flush()
                    if c.find(".//ShapePicture") is not None:
                        html_out.append('<p class="pic">🖼 그림 – 아래 [원문 페이지]에서 확인하세요</p>')
                    self.render_container(c, html_out, text_out, in_cell)
                elif c.tag in SKIP_TAGS:
                    continue
        flush()

    def render_container(self, e, html_out, text_out, in_cell=False):
        for c in e:
            if c.tag in SKIP_TAGS:
                continue
            if c.tag == "Paragraph":
                self.render_par(c, html_out, text_out, in_cell)
            else:
                self.render_container(c, html_out, text_out, in_cell)

    def render_table(self, tc, html_out, text_out):
        body = tc.find("TableBody")
        if body is None:
            return
        cells = []   # (row, col, rowspan, colspan, html, text)
        texts = []
        for tr in body.findall("TableRow"):
            for td in tr.findall("TableCell"):
                ch, ct = [], []
                self.render_container(td, ch, ct, in_cell=True)
                texts.extend(ct)
                cells.append((int(td.get("row", 0)), int(td.get("col", 0)),
                              int(td.get("rowspan", 1)), int(td.get("colspan", 1)),
                              "".join(ch), "".join(ct).strip()))
        if not "".join(texts).strip():
            return
        full = [c for c in cells if c[5]]
        if len(full) == 1:  # 내용 있는 칸이 하나뿐인 표 = 안내 박스
            html_out.append(f'<div class="box">{full[0][4]}</div>')
            text_out.append(" / ".join(texts))
            return
        # 레이아웃용 빈 행/열 제거: 내용 있는 칸이 '시작'하는 행/열만 남김
        keep_r = sorted({c[0] for c in full})
        keep_c = sorted({c[1] for c in full})
        rmap = {r: i for i, r in enumerate(keep_r)}
        kc = set(keep_c)
        grid = {}
        for r, c, rs, cs, h, t in cells:
            if r not in rmap or c not in kc:
                continue
            nrs = max(1, sum(1 for x in range(r, r + rs) if x in rmap))
            ncs = max(1, sum(1 for x in range(c, c + cs) if x in kc))
            grid.setdefault(rmap[r], []).append((c, nrs, ncs, h))
        out = ['<div class="tw"><table>']
        for ri in range(len(keep_r)):
            out.append("<tr>")
            for c, nrs, ncs, h in sorted(grid.get(ri, [])):
                attr = (f' rowspan="{nrs}"' if nrs > 1 else "") + (f' colspan="{ncs}"' if ncs > 1 else "")
                out.append(f"<td{attr}>{h}</td>")
            out.append("</tr>")
        out.append("</table></div>")
        html_out.append("".join(out))
        text_out.append(" / ".join(texts))


# ---------------------------------------------------------------- 문서 구조화
def build_structure(xml_path: Path):
    root = ET.parse(xml_path).getroot()
    paras = root.find(".//ColumnSet").findall("Paragraph")
    R = Renderer()

    parts = []
    intro = {"id": "p0", "num": 0, "title": "편람 소개", "subtitle": "일반사항 · 구성체계",
             "intro_html": "", "chapters": []}
    cur_part = intro
    cur_ch = None
    cur_sec = None
    ch_html, ch_text = [], []   # 장 도입부(절 이전) 버퍼

    def new_section(title, num):
        nonlocal cur_sec
        cur_sec = {"id": f"{cur_ch['id']}-{num}", "num": f"{cur_ch['num']}.{num}",
                   "title": title, "html": [], "text": []}
        cur_ch["sections"].append(cur_sec)

    for p in paras:
        st = p.get("style-id")
        if st == ST_PART:
            t = R.para_text(p)
            m = re.match(r"Part\s*(\d+)\.\s*(.*)", t)
            if not m:
                continue
            n = int(m.group(1))
            title, _, sub = m.group(2).partition("❘")
            cur_part = {"id": f"p{n}", "num": n, "title": title.strip(),
                        "subtitle": sub.strip(), "chapters": []}
            parts.append(cur_part)
            cur_ch = cur_sec = None
            continue
        if st == ST_CHAPTER and cur_part is not intro:
            t = R.para_text(p)
            n = len(cur_part["chapters"]) + 1
            cur_ch = {"id": f"{cur_part['id']}-{n}", "num": f"{n}", "title": t.strip(),
                      "sections": []}
            cur_part["chapters"].append(cur_ch)
            cur_sec = None
            continue
        if st == ST_SECTION and cur_ch is not None:
            t = R.para_text(p)
            new_section(t.strip(), len(cur_ch["sections"]) + 1)
            continue
        # 본문
        if cur_part is intro:
            if cur_ch is None:
                cur_ch = {"id": "p0-1", "num": "1", "title": "업무편람 안내", "sections": []}
                intro["chapters"].append(cur_ch)
                new_section("일반사항 및 편람 소개", 1)
        elif cur_ch is None:
            continue  # Part 표지 문구
        elif cur_sec is None:
            new_section("개요", 0)
            cur_sec["id"] = f"{cur_ch['id']}-0"
            cur_sec["num"] = f"{cur_ch['num']}"
        R.render_par(p, cur_sec["html"], cur_sec["text"])

    all_parts = [intro] + parts
    # 정리: 빈 개요 제거, 소제목 번호 붙이기
    for part in all_parts:
        for ch in part["chapters"]:
            ch["sections"] = [s for s in ch["sections"]
                              if s["text"] or s["title"] != "개요"]
            for s in ch["sections"]:
                k = 0
                fixed = []
                for b in s["html"]:
                    if b.startswith("<h4>"):
                        k += 1
                        b = f"<h4>{s['num']}.{k}. {b[4:]}"
                    fixed.append(b)
                s["html"] = "\n".join(fixed)
                s["text"] = "\n".join(s["text"])
    return all_parts


# ---------------------------------------------------------------- PDF 쪽 번호 매핑 & 이미지
def norm(s):
    return re.sub(r"[^0-9A-Za-z가-힣]", "", s)


def map_pages(parts, pdf: Path):
    import pymupdf
    doc = pymupdf.open(pdf)
    pages = [norm(pg.get_text()) for pg in doc]
    cursor = 0
    for part in parts:
        for ch in part["chapters"]:
            for s in ch["sections"]:
                if s["title"] == "개요" or part["num"] == 0:
                    key = norm(ch["title"])[:12]
                else:
                    key = norm(s["num"] + s["title"])[:14]
                found = None
                for i in range(cursor, len(pages)):
                    if key and key in pages[i]:
                        found = i
                        break
                if found is None:
                    for i in range(cursor, min(cursor + 6, len(pages))):
                        if norm(s["title"])[:8] in pages[i]:
                            found = i
                            break
                if found is not None:
                    cursor = found
                s["page"] = (found if found is not None else cursor) + 1
    return doc.page_count


def render_pages(pdf: Path, outdir: Path, zoom=1.4):
    import pymupdf
    from PIL import Image
    outdir.mkdir(parents=True, exist_ok=True)
    doc = pymupdf.open(pdf)
    for i, pg in enumerate(doc):
        fn = outdir / f"p{i + 1:03d}.webp"
        if fn.exists():
            continue
        pix = pg.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        img.save(fn, "WEBP", quality=62, method=4)
        if (i + 1) % 25 == 0:
            print(f"  원문 이미지 {i + 1}/{doc.page_count}", flush=True)


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--xml", type=Path)
    ap.add_argument("--hwp", type=Path)
    ap.add_argument("--pdf", type=Path)
    ap.add_argument("--no-pages", action="store_true")
    a = ap.parse_args()

    hwp = a.hwp or latest("*.hwp")
    pdf = a.pdf or latest("*.pdf")
    xml_path = a.xml or hwp_to_xml(hwp)
    parts = build_structure(xml_path)

    npages = 0
    if pdf:
        npages = map_pages(parts, pdf)
        if not a.no_pages:
            print("원문 페이지 이미지 생성 중…", flush=True)
            render_pages(pdf, SITE / "pages")

    src = (hwp or pdf).name if (hwp or pdf) else ""
    ver = re.search(r"v(\d+)\s*(\d{6})?", src)
    meta = {
        "title": "산업단지 개발사업 업무편람",
        "source": src,
        "version": f"v{ver.group(1)}" + (f" ({ver.group(2)})" if ver and ver.group(2) else "") if ver else "",
        "built": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "pages": npages,
    }
    out = SITE / "data" / "manual.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"meta": meta, "parts": parts}, ensure_ascii=False), encoding="utf-8")
    nsec = sum(len(c["sections"]) for p in parts for c in p["chapters"])
    print(f"완료: Part {len(parts)}개, 절 {nsec}개, PDF {npages}쪽 → {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
