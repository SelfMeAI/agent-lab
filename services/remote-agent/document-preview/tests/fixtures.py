"""Real Office fixtures produced by LibreOffice's native SDK, without models.

Executed in a disposable, network-disabled official renderer container. Inputs
and outputs stay in the project's ignored .work test directory.
"""
import contextlib
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from uuid import uuid4

import uno
from com.sun.star.beans import PropertyValue
from com.sun.star.awt import Point, Size


def properties(**values):
    return tuple(PropertyValue(Name=name, Value=value) for name, value in values.items())


def generate(output):
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="fixture-profile-", dir=output) as profile:
        name = "selfme_fixture_" + uuid4().hex
        process = subprocess.Popen(["soffice", "-env:UserInstallation=" + Path(profile).as_uri(), "--headless", "--nologo", "--norestore", "--nodefault", "--accept=pipe,name=" + name + ";urp;StarOffice.ServiceManager"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        documents = []
        try:
            resolver = uno.getComponentContext().ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", uno.getComponentContext())
            deadline = time.monotonic() + 20
            while True:
                try:
                    context = resolver.resolve("uno:pipe,name=" + name + ";urp;StarOffice.ComponentContext")
                    break
                except Exception:
                    if time.monotonic() >= deadline or process.poll() is not None:
                        raise RuntimeError("fixture office failed to start")
                    time.sleep(0.1)
            desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
            def document(kind):
                value = desktop.loadComponentFromURL("private:factory/" + kind, "_blank", 0, properties(Hidden=True, MacroExecutionMode=0, UpdateDocMode=0))
                documents.append(value)
                return value
            def save(value, extension, filter_name, **options):
                value.storeToURL((output / ("office-proof." + extension)).as_uri(), properties(FilterName=filter_name, Overwrite=True, **options))
            writer = document("swriter")
            writer.Text.String = "办公文档预览验收\nOffice Preview Proof\n中文、表格、分页与原文件完整性\n" + "这是一份真实的办公文档，用于验证远端只读预览。\n" * 45
            cursor = writer.Text.createTextCursor()
            cursor.gotoEnd(True)
            cursor.CharFontName = "Noto Sans CJK SC"
            cursor.CharFontNameAsian = "Noto Sans CJK SC"
            cursor.CharHeight = 14
            table = writer.createInstance("com.sun.star.text.TextTable")
            table.initialize(3, 3)
            writer.Text.insertTextContent(writer.Text.getEnd(), table, False)
            for name, text in {"A1": "项目", "B1": "金额", "C1": "状态", "A2": "预览测试", "B2": "1337", "C2": "通过"}.items():
                table.getCellByName(name).String = text
            save(writer, "docx", "Office Open XML Text")
            save(writer, "doc", "MS Word 97")
            writer.storeToURL((output / "encrypted.docx").as_uri(), properties(FilterName="Office Open XML Text", Overwrite=True, Password="fixture-password"))

            calc = document("scalc")
            first = calc.Sheets.getByIndex(0)
            first.Name = "数据"
            first.getCellRangeByName("A1:C4").setDataArray((("Office Preview Proof", "金额", "状态"), ("办公表格预览", 1000, "通过"), ("费用", 337, "通过"), ("合计", 0, "通过")))
            first.getCellRangeByName("B4").Formula = "=SUM(B2:B3)"
            first.getColumns().getByIndex(0).Width = 8000
            first.getColumns().getByIndex(1).Width = 3000
            first.getColumns().getByIndex(2).Width = 3000
            first.getCellRangeByName("A1:C4").CharFontNameAsian = "Noto Sans CJK SC"
            first.getCellRangeByName("A1:C4").CharHeight = 14
            calc.Sheets.insertNewByName("第二张表", 1)
            calc.Sheets.getByIndex(1).getCellRangeByName("A1").String = "第二张表 · Multi Sheet Proof"
            save(calc, "xlsx", "Calc MS Excel 2007 XML")
            save(calc, "xls", "MS Excel 97")

            impress = document("simpress")
            for index in range(2):
                page = impress.DrawPages.getByIndex(0) if index == 0 else impress.DrawPages.insertNewByIndex(index)
                page.Width, page.Height = 28000, 15750
                while page.Count:
                    page.remove(page.getByIndex(0))
                for position, text, font_size in ((1500, "Office Preview Proof", 36), (5500, "演示文稿预览验收 · 第 " + str(index + 1) + " 页", 24), (9500, "中文文本、分页、原文件下载", 20)):
                    shape = impress.createInstance("com.sun.star.drawing.TextShape")
                    shape.Position, shape.Size = Point(1800, position), Size(24400, 2600)
                    page.add(shape)
                    shape.String = text
                    shape.CharFontName = shape.CharFontNameAsian = "Noto Sans CJK SC"
                    shape.CharHeight = shape.CharHeightAsian = font_size
                page.Name = "Slide " + str(index + 1)
            save(impress, "pptx", "Impress MS PowerPoint 2007 XML")
            save(impress, "ppt", "MS PowerPoint 97")
        finally:
            for value in reversed(documents):
                with contextlib.suppress(Exception):
                    value.close(True)
            process.terminate()
            with contextlib.suppress(subprocess.TimeoutExpired):
                process.wait(timeout=5)
            if process.poll() is None:
                process.kill()
                process.wait()


if __name__ == "__main__":
    generate(Path(sys.argv[1]).resolve())
