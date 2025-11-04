🌀 FlowScrape – Quick Use
    Run basic test
    npm run dev -- https://hpgbrands.com/best-sellers/

    Show browser (no headless)
    npm run dev -- https://hpgbrands.com/best-sellers/ --no-headless

    Log levels
    FS_LOG_LEVEL=info   # normal
    FS_LOG_LEVEL=debug  # detailed

    Examples
    FS_LOG_LEVEL=info npm run dev -- https://hpgbrands.com/best-sellers/
    FS_LOG_LEVEL=debug npm run dev -- https://hpgbrands.com/best-sellers/ --no-headless

⚡ Run without classification (raw autodetect mode)

    Skip site-type detection and use only autodetect + learned selectors:

    npm run dev -- https://www.randomsite.com/shop --raw
    
    Or with browser open and debug logs:
     
    FS_LOG_LEVEL=debug npm run dev -- https://hpgbrands.com/best-sellers/ --raw --no-headless
    FS_LOG_LEVEL=info npm run dev -- https://hpgbrands.com/new/ --raw --no-headless
    FS_LOG_LEVEL=debug npm run dev -- https://www.nike.com/ca/w/mens-shoes-nik1zy7ok --raw --no-headless
    FS_LOG_LEVEL=debug npm run dev -- https://www.zara.com/ca/en/man-shoes-l715.html --raw --no-headless
    FS_LOG_LEVEL=debug npm run dev -- https://weirdsite.com/products --raw --no-headless   
    FS_LOG_LEVEL=debug npm run dev -- https://www.nike.com/ca/w/mens-shoes-nik1zy7ok --raw --no-headless   
    FS_LOG_LEVEL=info npm run dev -- https://jefedefilas.com/en/collections/stickers-bicicletas --raw --no-headless   
    FS_LOG_LEVEL=info npm run dev -- https://jefedefilas.com/en/collections/stickers-bicicletas --raw --no-headless
        FS_LOG_LEVEL=info npm run dev -- https://www.allbirds.ca/collections/mens-shoes --raw --no-headless
        FS_LOG_LEVEL=info npm run dev -- https://www.gymshark.com/collections/mens-tops --raw --no-headless
        FS_LOG_LEVEL=info npm run dev -- https://snugzusa.com/category/products --raw --no-headless
        FS_LOG_LEVEL=info npm run dev -- https://www.pcna.com/en-us/category/bags --raw --no-headless
        FS_LOG_LEVEL=info npm run dev -- https://www.nike.com/ca/w/mens-shoes-nik1zy7ok --raw --no-headless
        FS_LOG_LEVEL=info npm run dev -- https://www.zara.com/ca/en/man-shoes-l715.html --raw --no-headless
        FS_LOG_LEVEL=info npm run dev -- https://www.bestbuy.ca/en-ca/category/laptops/36711 --raw --no-headless
        FS_LOG_LEVEL=info npm run dev -- https://hpgbrands.com/best-sellers/ --raw --no-headless





    This uses engine.raw.ts — ideal for unknown or non-Shopify/BigCommerce sites.

🧩 Key outputs
    File	Purpose
    storage/items.jsonl	Extracted products/data
    storage/pages.html.jsonl	Saved HTML snapshots
    storage/learned.json	Remembered selectors per host
    🔍 Check logs

    Classified as: → site type (normal flow)

    best list selector found: → detected grid selector

    extracted items: → extraction worked

    learned selectors saved: → auto-learning succeeded

    [raw] extracted items: → autodetect mode working (raw flow)