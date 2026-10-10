Makes Arabic and mixed Arabic and English messages read correctly in the Paseo web app and desktop app. Paragraphs, headings, and list items in assistant replies, and your own messages, get a right-to-left base direction when the text is mostly Arabic, so they align to the right and keep English terms in the right place. Code blocks and inline code stay left-to-right.

Direction is chosen per block from its text. If the first letter is Arabic, the block is right-to-left. Otherwise it is right-to-left only when Arabic words outnumber Latin words. Text inside inline code is ignored.

It works by adding a stylesheet and setting `dir` attributes on the rendered message elements in the page. It reads only the text already on screen and sends nothing anywhere.

Known limits: it does nothing on iOS and Android, because plugins cannot change how Paseo renders Markdown there. Tables, blockquotes, and the composer are not changed. It relies on Paseo's current message markup, so a future Paseo release can break it.
