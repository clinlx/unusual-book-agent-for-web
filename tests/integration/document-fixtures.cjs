'use strict';
const JSZip = require('jszip');
const { deflateSync } = require('node:zlib');
function pdfDocument(scanned = false) {
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>'];
  objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 594] /Resources << /Font << /F1 7 0 R >> /XObject << /Im1 8 0 R >> >> /Contents 4 0 R >>');
  const stream = bytes => Buffer.concat([Buffer.from('<< /Length ' + bytes.length + ' >>\nstream\n'), bytes, Buffer.from('\nendstream')]);
  objects.push(stream(Buffer.from(scanned ? 'q 250 0 0 150 40 350 cm /Im1 Do Q' : 'BT /F1 22 Tf 40 510 Td (HELLO PDF PAGE ONE) Tj ET\n0.1 0.4 0.8 rg 40 350 250 80 re f')));
  objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 594] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>');
  objects.push(stream(Buffer.from(scanned ? '0.8 0.2 0.1 rg 40 350 250 80 re f' : 'BT /F1 22 Tf 40 510 Td (PDF PAGE TWO END) Tj ET')));
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pixels = Buffer.alloc(90 * 60 * 3);
  for (let i = 0; i < pixels.length; i += 3) { pixels[i] = 30; pixels[i + 1] = Math.floor(i / 270) % 2 ? 70 : 190; pixels[i + 2] = 130; }
  const compressed = deflateSync(pixels);
  objects.push(Buffer.concat([Buffer.from('<< /Type /XObject /Subtype /Image /Width 90 /Height 60 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ' + compressed.length + ' >>\nstream\n'), compressed, Buffer.from('\nendstream')]));
  const chunks = [Buffer.from('%PDF-1.7\n')], offsets = [0]; let length = chunks[0].length;
  for (let i = 1; i < objects.length; i++) { offsets[i] = length; const chunk = Buffer.concat([Buffer.from(i + ' 0 obj\n'), Buffer.from(objects[i]), Buffer.from('\nendobj\n')]); chunks.push(chunk); length += chunk.length; }
  chunks.push(Buffer.from('xref\n0 ' + objects.length + '\n0000000000 65535 f \n' + offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('') + 'trailer\n<< /Size ' + objects.length + ' /Root 1 0 R >>\nstartxref\n' + length + '\n%%EOF'));
  return Buffer.concat(chunks);
}
async function docxDocument(long = false) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:b/><w:sz w:val="36"/></w:rPr><w:t>文档解析测试 DOCX PAGE ONE</w:t></w:r></w:p><w:p><w:r><w:t>主角来到雨夜车站。保留中文、段落与表格。</w:t></w:r></w:p><w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="8"/><w:bottom w:val="single" w:sz="8"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>姓名</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>林青</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:t>第二页 DOCX PAGE TWO END</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>');
  if (long) {
    const xml = await zip.file('word/document.xml').async('string');
    const paragraphs = Array.from({ length: 85 }, (_, i) => '<w:p><w:r><w:t>连续段落 ' + i + ' LONG DOCUMENT LINE</w:t></w:r></w:p>').join('');
    const tail = '<w:p><w:pPr><w:shd w:fill="FF0000"/></w:pPr><w:r><w:t>LONG DOCUMENT TAIL</w:t></w:r></w:p>';
    zip.file('word/document.xml', xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>[\s\S]*?(?=<w:sectPr>)/, paragraphs + tail));
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}
module.exports = { pdfDocument, docxDocument };
