import { describe, expect, it } from "vitest";
import { escapeHtml, kindCounts, licenceKind, licencesListHtml, licencesText, splitName, summaryLine } from "./licences";

const MIT = "MIT License\n\nCopyright (c) 2026 A\n\nPermission is hereby granted, free of charge, to any person obtaining a copy";
const APACHE = "Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/";
const LLVM = "The LLVM Project is under the Apache License v2.0 with LLVM Exceptions:\n" + APACHE;
const BSD2 = "Redistribution and use in source and binary forms, with or without modification, are permitted provided that";
const BSD3 = BSD2 + " ... Neither the name of the copyright holder nor the names of its contributors may be used";

describe("licenceKind", () => {
  it.each([
    [MIT, "MIT"],
    [APACHE, "Apache 2.0"],
    [LLVM, "Apache 2.0 with LLVM exceptions"],
    ["Mozilla Public License Version 2.0\n==================================", "MPL 2.0"],
    ["Copyright 2020 The Geist Project Authors\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.", "SIL Open Font 1.1"],
    ["PYTHON SOFTWARE FOUNDATION LICENSE VERSION 2", "Python (PSF)"],
    ["ISC License\n\nPermission to use, copy, modify, and/or distribute this software for any purpose with or without fee", "ISC"],
    [BSD2, "BSD 2-clause"],
    [BSD3, "BSD 3-clause"],
    ["This software is provided 'as-is', without any express or implied warranty. 3. Altered source versions must be plainly marked", "zlib"],
    ["All rights reserved.", "Other licence"],
  ])("reads %#", (text, kind) => {
    expect(licenceKind(text)).toBe(kind);
  });
});

describe("the plain text file", () => {
  it("is the heading, the notes, then each text under its name between rules", () => {
    const rule = "=".repeat(78);
    expect(licencesText(["T"], ["a"], [{ name: "X", text: "x" }, { name: "Y", text: "y" }])).toBe(["T", "", "- a", "", rule, "X", rule, "x", "", rule, "Y", rule, "y", ""].join("\n"));
  });
});

describe("the page's list", () => {
  it("splits a package's version off its name, and leaves a described name whole", () => {
    expect(splitName("@codemirror/view 6.43.14")).toEqual({ name: "@codemirror/view", version: "6.43.14" });
    expect(splitName("crelt 1.0.7")).toEqual({ name: "crelt", version: "1.0.7" });
    expect(splitName("LLVM 22: clang and lld, in the C/C++ pack")).toEqual({ name: "LLVM 22: clang and lld, in the C/C++ pack", version: null });
  });

  it("puts every licence text in escaped, never as markup", () => {
    const evil = '<img src=x onerror=alert(1)> & "quoted"';
    const html = licencesListHtml([{ name: `pkg${evil}`, text: evil }]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quoted&quot;");
    expect(escapeHtml("'")).toBe("&#39;");
  });

  it("gives each row an id, its kind and what the find box matches", () => {
    const html = licencesListHtml([{ name: "ExecFlow", text: MIT }, { name: "Pyodide 314.0.7 (served from /pyodide/)", text: "Mozilla Public License Version 2.0" }]);
    expect(html).toContain('id="lic-1" data-filter="execflow mit"');
    expect(html).toContain('id="lic-2" data-filter="pyodide 314.0.7 (served from /pyodide/) mpl 2.0"');
    expect(html).toContain('<span class="lic-kind">MPL 2.0</span>');
  });

  it("sums the kinds, most first, in one sentence", () => {
    const entries = [{ name: "a", text: MIT }, { name: "b", text: MIT }, { name: "c", text: APACHE }];
    expect(kindCounts(entries)).toEqual([["MIT", 2], ["Apache 2.0", 1]]);
    expect(summaryLine(entries)).toBe("3 licence texts: 2 MIT and 1 Apache 2.0.");
    expect(summaryLine(entries.slice(0, 1))).toBe("1 licence texts: 1 MIT.");
  });
});
