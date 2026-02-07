
const regex = /```(?:[\w-]*\n)?\s*(!\[[^\]]*\]\([^)]*\))\s*```/g;

const testCases = [
    // Case 1: Simple
    "```\n![image](https://example.com/img.png)\n```",
    // Case 2: With markdown specifier
    "```markdown\n![image](https://example.com/img.png)\n```",
    // Case 3: Extra spaces
    "```  \n   ![image](https://example.com/img.png)   \n   ```",
    // Case 4: Base64 (simulated)
    "```\n![image](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=)\n```",
    // Case 5: Text around it (Should NOT unwrap ideally, or maybe we want to unwrap just the image part?)
    // The current regex is intended to unwrap ONLY if the block contains ONLY the image.
    "```\nHere is an image:\n![image](url)\n```",
    // Case 6: Multiple images?
    "```\n![img1](url1)\n![img2](url2)\n```"
];

testCases.forEach((test, i) => {
    console.log(`--- Test Case ${i + 1} ---`);
    console.log("Original:", JSON.stringify(test));
    const replaced = test.replace(regex, '$1');
    console.log("Replaced:", JSON.stringify(replaced));
    console.log("Match?", test !== replaced);
});
