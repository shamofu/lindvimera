# Third-party notices

This file records notices for the Vim engine, Neovim word-object traversal, Lindera/IPADIC, and the BudouX fallback parser/model bundled with Lindvimera. Lindvimera's original source is distributed under the MIT license in `LICENSE`; adapted portions and dependencies retain their original licenses below.

The standard Obsidian installation consists of `main.js`, `manifest.json`, and `styles.css`. `main.js` retains the complete `LICENSE`, this document, `src/word/text-object.ts`, `lindera/LICENSE`, and `lindera/ipadic/NOTICE.txt` in readable line comments labeled with their paths at its end. These files are also included separately in the release ZIP.

## CodeMirror Vim

- Project: [replit/codemirror-vim](https://github.com/replit/codemirror-vim)
- Pinned commit: `8640966b6977f84d2197e6adfd521fb737184587`
- Packages: `@replit/codemirror-vim` 6.4.0 and `@replit/codemirror-vim-core` 0.1.0
- Source of the following notice: the pinned repository's `LICENSE` and both packages' `LICENSE` files.
- Local changes are maintained as the ordered patches in `patches/series.json`: per-editor word boundaries, conditional mappings and operator continuations, editor-target adapters, and operation/recording notifications. The submodule working tree remains unmodified during builds.

```text
MIT License

Copyright (C) 2018-2021 by Marijn Haverbeke <marijnh@gmail.com> and others

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

The Vim core also carries this attribution:

```text
CodeMirror, copyright (c) by Marijn Haverbeke and others
Distributed under an MIT license: https://codemirror.net/5/LICENSE
```

## Neovim word-object traversal

- Reference: [Neovim `src/nvim/textobject.c` at `f8cfd7f06ae87d47aac04ddce860b302f7820858`](https://github.com/neovim/neovim/blob/f8cfd7f06ae87d47aac04ddce860b302f7820858/src/nvim/textobject.c), `current_word` and its word traversal helpers. Fixed behavior tests were recorded with Neovim 0.12.5.
- Copyright Neovim contributors. All rights reserved.
- Neovim uses the Apache License 2.0 except for original Vim portions that retain the Vim license. Its complete, unmodified license is reproduced below.
- The adapted implementation is `src/word/text-object.ts`, also included as source in the distribution under the Vim license's source-distribution option II.2(c). Changes replace native cursor/buffer APIs with a TypeScript walker over per-editor UTF-16 grapheme and token spans, and convert results to half-open selections. This is a modified implementation, not an unmodified Neovim component.

```text
Copyright Neovim contributors. All rights reserved.

Neovim is licensed under the terms of the Apache 2.0 license, except for
parts of Neovim that were contributed under the Vim license (see below).

Neovim's license follows:

====
                                 Apache License
                           Version 2.0, January 2004
                        https://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

====

The above license applies to all parts of Neovim except (1) parts that were
contributed under the Vim license and (2) externally maintained libraries.

The externally maintained libraries used by Neovim are:

  - Klib: a Generic Library in C. MIT/X11 license.
  - Lua: MIT license
  - LuaJIT: a Just-In-Time Compiler for Lua. Copyright Mike Pall. MIT license.
  - Luv: Apache 2.0 license
  - gettext
  - libiconv
  - libmpack: MIT license
  - libtermkey: MIT license
  - libuv. Copyright Joyent, Inc. and other Node contributors. Node.js license.
  - libvterm: MIT license
  - lua-bitop: MIT license
  - lua-cjson: MIT license
  - lua-compat: MIT license
  - lua-inspect: MIT license
  - lua-lpeg: MIT license
  - tree-sitter: MIT license
  - xdiff: LGPL v2
  - (Deprecated) unibilium: LGPL v3

====

Any parts of Neovim that were contributed under the Vim license are licensed
under the Vim license unless the copyright holder gave permission to license
those contributions under the Apache 2.0 license.

The Vim license follows:

VIM LICENSE

I)  There are no restrictions on distributing unmodified copies of Vim except
    that they must include this license text.  You can also distribute
    unmodified parts of Vim, likewise unrestricted except that they must
    include this license text.  You are also allowed to include executables
    that you made from the unmodified Vim sources, plus your own usage
    examples and Vim scripts.

II) It is allowed to distribute a modified (or extended) version of Vim,
    including executables and/or source code, when the following four
    conditions are met:
    1) This license text must be included unmodified.
    2) The modified Vim must be distributed in one of the following five ways:
       a) If you make changes to Vim yourself, you must clearly describe in
	  the distribution how to contact you.  When the maintainer asks you
	  (in any way) for a copy of the modified Vim you distributed, you
	  must make your changes, including source code, available to the
	  maintainer without fee.  The maintainer reserves the right to
	  include your changes in the official version of Vim.  What the
	  maintainer will do with your changes and under what license they
	  will be distributed is negotiable.  If there has been no negotiation
	  then this license, or a later version, also applies to your changes.
	  The current maintainers are listed here: https://github.com/orgs/vim/people.
	  If this changes it will be announced in appropriate places (most likely
	  vim.sf.net, www.vim.org and/or comp.editors).  When it is completely
	  impossible to contact the maintainer, the obligation to send him
	  your changes ceases.  Once the maintainer has confirmed that he has
	  received your changes they will not have to be sent again.
       b) If you have received a modified Vim that was distributed as
	  mentioned under a) you are allowed to further distribute it
	  unmodified, as mentioned at I).  If you make additional changes the
	  text under a) applies to those changes.
       c) Provide all the changes, including source code, with every copy of
	  the modified Vim you distribute.  This may be done in the form of a
	  context diff.  You can choose what license to use for new code you
	  add.  The changes and their license must not restrict others from
	  making their own changes to the official version of Vim.
       d) When you have a modified Vim which includes changes as mentioned
	  under c), you can distribute it without the source code for the
	  changes if the following three conditions are met:
	  - The license that applies to the changes permits you to distribute
	    the changes to the Vim maintainer without fee or restriction, and
	    permits the Vim maintainer to include the changes in the official
	    version of Vim without fee or restriction.
	  - You keep the changes for at least three years after last
	    distributing the corresponding modified Vim.  When the maintainer
	    or someone who you distributed the modified Vim to asks you (in
	    any way) for the changes within this period, you must make them
	    available to him.
	  - You clearly describe in the distribution how to contact you.  This
	    contact information must remain valid for at least three years
	    after last distributing the corresponding modified Vim, or as long
	    as possible.
       e) When the GNU General Public License (GPL) applies to the changes,
	  you can distribute the modified Vim under the GNU GPL version 2 or
	  any later version.
    3) A message must be added, at least in the output of the ":version"
       command and in the intro screen, such that the user of the modified Vim
       is able to see that it was modified.  When distributing as mentioned
       under 2)e) adding the message is only required for as far as this does
       not conflict with the license used for the changes.
    4) The contact information as required under 2)a) and 2)d) must not be
       removed or changed, except that the person himself can make
       corrections.

III) If you distribute a modified version of Vim, you are encouraged to use
     the Vim license for your changes and make them available to the
     maintainer, including the source code.  The preferred way to do this is
     by e-mail or by uploading the files to a server and e-mailing the URL.
     If the number of changes is small (e.g., a modified Makefile) e-mailing a
     context diff will do.  The e-mail address to be used is
     <maintainer@vim.org>

IV)  It is not allowed to remove this license from the distribution of the Vim
     sources, parts of it or from a modified version.  You may use this
     license for previous Vim releases instead of the license that they came
     with, at your option.

====

In addition, different license conditions may apply to some runtime files
included with Vim; these will be specified in the header of each respective
file.
```

## BudouX

- Project: [google/budoux](https://github.com/google/budoux)
- Installed JavaScript package: `budoux` 0.9.2
- License declaration: `Apache-2.0` in the installed package's `package.json`.
- Attribution below: the installed `src/parser.ts` and `src/index.ts` headers.
- License text: [upstream LICENSE](https://github.com/google/budoux/blob/main/LICENSE).
- The unmodified Japanese model and plain-text parser are bundled for word motions and text objects. Plugin integration and its boundary cache are maintained separately in `src/word`.

```text
Copyright 2021 Google LLC
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    https://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

BudouX's upstream disclaimer: This is not an officially supported Google product.

## Lindera WebAssembly

- Project: [lindera/lindera](https://github.com/lindera/lindera)
- Package: `lindera-wasm` 6.0.0, distributed under the MIT license.
- The unmodified WebAssembly bytes are compressed and embedded in `main.js` under the logical key `lindera/lindera_wasm_bg.wasm`; its JavaScript bindings are also bundled into `main.js`.
- The following notice is copied from the 6.0.0 npm package's `LICENSE`, also distributed as `lindera/LICENSE`.

```text
MIT License

Copyright (c) 2024 by the project authors.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## IPADIC dictionary

- Artifact: `lindera-ipadic-6.0.0.zip` from the [Lindera 6.0.0 release](https://github.com/lindera/lindera/releases/tag/v6.0.0).
- Archive SHA-256: `8433dbbb80d7588a565fb9247c1ac7aed3ca50c7463329e495f8bd905aece356`.
- The unmodified binary dictionary bytes are compressed and embedded in `main.js` under logical keys beginning with `lindera/ipadic/`.
- The complete upstream notice, including NAIST and ICOT's redistribution and warranty terms for `mecab-ipadic-2.7.0-20070801`, accompanies the dictionary as `lindera/ipadic/NOTICE.txt`. Those terms apply to the dictionary separately from the Lindera MIT license.
- Build-time downloads are verified against pinned hashes in `scripts/lindera-assets.mjs`. The distributed plugin decompresses its embedded assets in memory and does not download dictionaries or extract files at runtime.

## Host-provided modules and development tools

The build externalizes Obsidian, Electron, `@codemirror/*`, `@lezer/*`, and Node.js built-ins (`node:*`); those modules are supplied by the Obsidian desktop host. Build and test tools are development dependencies and are not bundled into `main.js`. Their original package notices remain with their installed distributions.

## Apache License, Version 2.0

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
