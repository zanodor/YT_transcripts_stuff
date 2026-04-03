import * as obsidian from 'obsidian';

// 250325 Update: Script now can be used for subsequent runs to update content based on newly added replacement rules
// 170625 Update: Script is now configurable to replace list markers (- or *) with N-dashes to try and make these look good on Archive.ph
// 160725 Update: Contains lookbehind now (see 'speaker') so will NOT work on mobile but I did not intend to use this on mobile either
// 191225 Update: Handles conversion of YT timedtext json format
// 060126 Update: We can use the script in TUDASTAR vault as well to transform offending AI IDE made external links to md files (`[]()`)
// Chats: https://claude.ai/chat/5b54e748-1812-4d73-806b-200ac1136ffd és https://claude.ai/chat/a44bc0b7-5571-42dd-9085-c2990fc8b8bc

// Configuration
const CONFIG = {
    replaceListMarkers: true,
    listMarkerReplacements: [
        { from: /^(-|\*) (.*)/gm, to: '– $2' },
        { from: /^(?:\t| {2,})(-|\*) (.*)/gm, to: '<span style="margin-left: 2em">– $2</span>' },
        { from: /^(–|<span[^>]*>–)\s+\*\*(.+?)\*\*/gm, to: '$1 $2' }
    ]
};

// Simple string-based extractors to avoid complex regex
const extractVideoId = (content: string): string | null => {
    // Extract source line
    const lines = content.split('\n');
    let sourceLine = '';
    
    for (const line of lines) {
        if (line.trim().startsWith('source:')) {
            sourceLine = line;
            break;
        }
    }
    
    if (!sourceLine) return null;
    
    // Handle YouTube URLs
    if (sourceLine.includes('youtube.com/watch?v=')) {
        const parts = sourceLine.split('youtube.com/watch?v=');
        if (parts.length > 1) {
            const id = parts[1].split(/[&"\s]/)[0];
            console.log("Found YouTube video ID:", id);
            return id;
        }
    }
    
    if (sourceLine.includes('youtu.be/')) {
        const parts = sourceLine.split('youtu.be/');
        if (parts.length > 1) {
            const id = parts[1].split(/[&"\s]/)[0];
            console.log("Found YouTube video ID:", id);
            return id;
        }
    }
    
    // Handle Rumble URLs
    if (sourceLine.includes('rumble.com/')) {
        const parts = sourceLine.split('rumble.com/');
        if (parts.length > 1) {
            // Extract the full path after rumble.com/
            const path = parts[1].split(/["'\s]/)[0];
            console.log("Found Rumble path:", path);
            return path; // Return full path for Rumble
        }
    }
    
    // Handle Videa URLs
    if (sourceLine.includes('videa.hu/videok/')) {
        const parts = sourceLine.split('videa.hu/videok/');
        if (parts.length > 1) {
            const pathParts = parts[1].split('?')[0].split(/["'\s]/)[0];
            console.log("Found Videa path:", pathParts);
            return pathParts;
        }
    }

    // Handle BitChute URLs (both www. and old.)
    if (sourceLine.includes('bitchute.com/video/')) {
        const parts = sourceLine.split('bitchute.com/video/');
        if (parts.length > 1) {
            const id = parts[1].split(/[\/"'\s?]/)[0];
            console.log("Found BitChute video ID:", id);
            return id;
        }
    }
    
    return null;
};

// Helper to determine video platform
const getVideoPlatform = (content: string): { platform: 'youtube' | 'rumble' | 'videa' | 'bitchute' | null, id: string | null, host: string | null } => {
    // Extract source line
    const lines = content.split('\n');
    let sourceLine = '';
    
    for (const line of lines) {
        if (line.trim().startsWith('source:')) {
            sourceLine = line;
            break;
        }
    }
    
    // Check for YouTube in source
    if (sourceLine.includes('youtube.com') || sourceLine.includes('youtu.be')) {
        return { platform: 'youtube', id: extractVideoId(content), host: null };
    }
    
    // Check for Rumble in source
    if (sourceLine.includes('rumble.com')) {
        return { platform: 'rumble', id: extractVideoId(content), host: null };
    }

    // Check for Videa in source
    if (sourceLine.includes('videa.hu')) {
        return { platform: 'videa', id: extractVideoId(content), host: null };
    }

    // Check for BitChute in source (matches both www. and old.)
    if (sourceLine.includes('bitchute.com')) {
        const isOld = sourceLine.includes('old.bitchute.com');
        const host = isOld ? 'old.bitchute.com' : 'www.bitchute.com';
        return { platform: 'bitchute', id: extractVideoId(content), host };
    }
    
    return { platform: null, id: null, host: null };
};

// Parse timestamp to seconds
const parseTimestamp = (timestamp: string): number => {
    const parts = timestamp.split(':').map(Number);
    if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    } else if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    return 0;
};

// Convert seconds to timestamp format
const secondsToTimestamp = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
        return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
};

// Remove duplicate YouTube transcript lines (keep longer version)
const removeDuplicateTranscriptLines = (content: string): string => {
    const lines = content.split('\n');
    const result: string[] = [];
    
    for (let i = 0; i < lines.length; i++) {
        const currentLine = lines[i];
        
        // Check if this is a timestamp line
        if (!/^\[\d{2}:\d{2}(?::\d{2})?\]\(https?:\/\/[^)]+\)/.test(currentLine)) {
            result.push(currentLine);
            continue;
        }
        
        // Extract timestamp and text from current line
        const currentMatch = currentLine.match(/^(\[\d{2}:\d{2}(?::\d{2})?\]\([^)]+\))\s*(.*)$/);
        if (!currentMatch) {
            result.push(currentLine);
            continue;
        }
        
        const [, currentTimestamp, currentText] = currentMatch;
        const currentTextTrimmed = currentText.trim();
        let shouldSkip = false;
        
        // Safety check: Don't process lines that end with sentence terminators
        const endsWithPunctuation = /[.!?]\s*$/.test(currentTextTrimmed);
        
        // Look ahead at next few lines (only check next 3 lines for tighter scope)
        for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
            const nextLine = lines[j];
            const nextMatch = nextLine.match(/^(\[\d{2}:\d{2}(?::\d{2})?\]\([^)]+\))\s*(.*)$/);
            
            if (!nextMatch) continue;
            
            const [, nextTimestamp, nextText] = nextMatch;
            const nextTextTrimmed = nextText.trim();
            
            // Case 1: Same timestamp, current text is substring of next
            if (currentTimestamp === nextTimestamp && 
                nextTextTrimmed.includes(currentTextTrimmed) && 
                currentTextTrimmed.length < nextTextTrimmed.length) {
                shouldSkip = true;
                break;
            }
            
            // Case 3a: Exact duplicate text at different timestamps
            if (currentTextTrimmed === nextTextTrimmed) {
                shouldSkip = true;
                break;
            }
            
            // Case 3b: Current text is exact prefix of next text (even with punctuation)
            // This catches "Crazy times." followed by "Crazy times. The whole..."
            if (nextTextTrimmed.startsWith(currentTextTrimmed) && 
                nextTextTrimmed.length > currentTextTrimmed.length) {
                shouldSkip = true;
                break;
            }
            
            // Case 2: Different timestamp, YouTube's rolling transcript pattern
            // Only check if current line doesn't end with punctuation (incomplete sentence)
            if (!endsWithPunctuation) {
                const currentWords = currentTextTrimmed.split(/\s+/);
                
                // Require at least 5 words to match (reduces false positives)
                if (currentWords.length >= 5) {
                    // Check 5-8 word overlaps (sweet spot for YouTube's pattern)
                    for (let wordCount = Math.min(8, currentWords.length); wordCount >= 5; wordCount--) {
                        const endPhrase = currentWords.slice(-wordCount).join(' ');
                        
                        // Must be exact start match AND next line significantly longer
                        if (nextTextTrimmed.startsWith(endPhrase) && 
                            nextTextTrimmed.length > currentTextTrimmed.length + 10) {
                            shouldSkip = true;
                            break;
                        }
                    }
                }
            }
            
            if (shouldSkip) break;
        }
        
        if (!shouldSkip) {
            result.push(currentLine);
        }
    }
    
    return result.join('\n');
};

// NEW FUNCTION: Fix incorrect timestamps based on URL seconds parameter
const fixIncorrectTimestamps = (content: string): string => {
    let result = content;
    
    // Match timestamp links with pattern [HH:MM:SS](URL with t= or start= parameter)
    const timestampLinkRegex = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]\((https?:\/\/[^)]*?[?&](?:t|start)=(\d+)[^)]*?)\)/g;
    
    let match;
    const replacements = [];
    
    while ((match = timestampLinkRegex.exec(result)) !== null) {
        const [fullMatch, displayedTimestamp, url, secondsParam] = match;
        const seconds = parseInt(secondsParam);
        const correctTimestamp = secondsToTimestamp(seconds);
        
        // Only replace if the displayed timestamp doesn't match the URL seconds
        if (displayedTimestamp !== correctTimestamp) {
            console.log(`Fixing timestamp: [${displayedTimestamp}] -> [${correctTimestamp}] (${seconds} seconds)`);
            replacements.push({
                original: fullMatch,
                fixed: `[${correctTimestamp}](${url})`
            });
        }
    }
    
    // Apply all replacements
    for (const replacement of replacements) {
        result = result.replace(replacement.original, replacement.fixed);
    }
    
    return result;
};

// Fix existing timestamp links with simpler string operations
const fixExistingTimestampLinks = (content: string, platform: 'youtube' | 'rumble' | 'videa' | 'bitchute' | null, id: string | null, host: string | null): string => {
    if (!id) return content;
    
    const lines = content.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Look for timestamp patterns like [01:08](any_url)
        if (line.includes('[') && line.includes('](')) {
            
            // Collect all timestamp link matches in this line
            let modifiedLine = line;
            let bracketIndex = modifiedLine.indexOf('[');
            
            while (bracketIndex !== -1) {
                const closeBracketIndex = modifiedLine.indexOf(']', bracketIndex);
                if (closeBracketIndex === -1) break;
                
                const timestampText = modifiedLine.substring(bracketIndex + 1, closeBracketIndex);
                // Check if this is a timestamp format
                if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(timestampText)) {
                    const linkOpenIndex = modifiedLine.indexOf('(', closeBracketIndex);
                    if (linkOpenIndex === -1) break;
                    
                    const linkCloseIndex = modifiedLine.indexOf(')', linkOpenIndex);
                    if (linkCloseIndex === -1) break;
                    
                    // Extract the old URL and seconds
                    const oldUrl = modifiedLine.substring(linkOpenIndex + 1, linkCloseIndex);
                    let seconds = 0;
                    
                    // Extract seconds from any supported platform URL
                    if (oldUrl.includes('youtube.com') || oldUrl.includes('youtu.be')) {
                        const timeMatches = oldUrl.match(/[?&]t=(\d+)/);
                        if (timeMatches && timeMatches[1]) {
                            seconds = parseInt(timeMatches[1]);
                        } else {
                            seconds = parseTimestamp(timestampText);
                        }
                    } else if (oldUrl.includes('rumble.com')) {
                        const timeMatches = oldUrl.match(/[?&]start=(\d+)/);
                        if (timeMatches && timeMatches[1]) {
                            seconds = parseInt(timeMatches[1]);
                        } else {
                            seconds = parseTimestamp(timestampText);
                        }
                    } else if (oldUrl.includes('videa.hu')) {
                        const timeMatches = oldUrl.match(/[?&]start=(\d+)/);
                        if (timeMatches && timeMatches[1]) {
                            seconds = parseInt(timeMatches[1]);
                        } else {
                            seconds = parseTimestamp(timestampText);
                        }
                    } else if (oldUrl.includes('bitchute.com')) {
                        const timeMatches = oldUrl.match(/[?&]t=(\d+)/);
                        if (timeMatches && timeMatches[1]) {
                            seconds = parseInt(timeMatches[1]);
                        } else {
                            seconds = parseTimestamp(timestampText);
                        }
                    } else {
                        seconds = parseTimestamp(timestampText);
                    }
                    
                    let newUrl = '';
                    
                    // Convert to the target platform format
                    if (platform === 'youtube') {
                        newUrl = `https://www.youtube.com/watch?v=${id}&t=${seconds}`;
                    } else if (platform === 'rumble') {
                        newUrl = `https://rumble.com/${id}${seconds > 0 ? `?start=${seconds}` : ''}`;
                    } else if (platform === 'videa') {
                        newUrl = `https://videa.hu/videok/${id}${seconds > 0 ? `?start=${seconds}` : ''}`;
                    } else if (platform === 'bitchute') {
                        const resolvedHost = host || 'www.bitchute.com';
                        newUrl = `https://${resolvedHost}/video/${id}/`;
                    }
                    
                    // Replace the entire link if we have a new URL
                    if (newUrl) {
                        const oldLink = modifiedLine.substring(bracketIndex, linkCloseIndex + 1);
                        const newLink = `[${timestampText}](${newUrl})`;
                        modifiedLine = modifiedLine.substring(0, bracketIndex) + 
                                      newLink + 
                                      modifiedLine.substring(linkCloseIndex + 1);
                    }
                }
                
                // Find next bracket
                bracketIndex = modifiedLine.indexOf('[', bracketIndex + 1);
            }
            
            lines[i] = modifiedLine;
        }
    }
    
    return lines.join('\n');
};

// Link unlinked timestamps
const linkUnlinkedTimestamps = (content: string, platform: 'youtube' | 'rumble' | 'videa' | 'bitchute' | null, id: string | null, host: string | null): string => {
    if (!id) return content;
    
    const lines = content.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let modifiedLine = line;
        
        // Match timestamp ranges like [01:08-01:45]
        const rangeMatches = [];
        const rangeRegex = /\[(\d{1,2}:\d{2})-(\d{1,2}:\d{2})\](?!\()/g;
        let match;
        
        while ((match = rangeRegex.exec(modifiedLine)) !== null) {
            rangeMatches.push({
                fullMatch: match[0],
                startTime: match[1],
                endTime: match[2],
                index: match.index
            });
        }
        
        // Process matches in reverse to avoid index shifting
        for (let j = rangeMatches.length - 1; j >= 0; j--) {
            const { fullMatch, startTime, endTime, index } = rangeMatches[j];
            const seconds = parseTimestamp(startTime);
            
            let newUrl = '';
            if (platform === 'youtube') {
                newUrl = `https://www.youtube.com/watch?v=${id}&t=${seconds}`;
            } else if (platform === 'rumble') {
                newUrl = `https://rumble.com/${id}${seconds > 0 ? `?start=${seconds}` : ''}`;
            } else if (platform === 'videa') {
                newUrl = `https://videa.hu/videok/${id}${seconds > 0 ? `?start=${seconds}` : ''}`;
            } else if (platform === 'bitchute') {
                const resolvedHost = host || 'www.bitchute.com';
                newUrl = `https://${resolvedHost}/video/${id}/`;
            }
            
            if (newUrl) {
                const replacement = `[${startTime}-${endTime}](${newUrl})`;
                modifiedLine = modifiedLine.substring(0, index) + 
                              replacement + 
                              modifiedLine.substring(index + fullMatch.length);
            }
        }
        
        // Match simple timestamps like [01:08]
        const simpleMatches = [];
        // const simpleRegex = /\[(\d{1,2}:\d{2})\](?!\()/g;
        // https://claude.ai/chat/10ddc720-e55b-4ef5-8924-b753f9a28a52 change
        const simpleRegex = /\[(\d{1,2}:\d{2}(?::\d{2})?)\](?!\()/g;
        
        while ((match = simpleRegex.exec(modifiedLine)) !== null) {
            simpleMatches.push({
                fullMatch: match[0],
                timestamp: match[1],
                index: match.index
            });
        }
        
        // Process matches in reverse to avoid index shifting
        for (let j = simpleMatches.length - 1; j >= 0; j--) {
            const { fullMatch, timestamp, index } = simpleMatches[j];
            const seconds = parseTimestamp(timestamp);
            
            let newUrl = '';
            if (platform === 'youtube') {
                newUrl = `https://www.youtube.com/watch?v=${id}&t=${seconds}`;
            } else if (platform === 'rumble') {
                newUrl = `https://rumble.com/${id}${seconds > 0 ? `?start=${seconds}` : ''}`;
            } else if (platform === 'videa') {
                newUrl = `https://videa.hu/videok/${id}${seconds > 0 ? `?start=${seconds}` : ''}`;
            } else if (platform === 'bitchute') {
                const resolvedHost = host || 'www.bitchute.com';
                newUrl = `https://${resolvedHost}/video/${id}/`;
            }
            
            if (newUrl) {
                const replacement = `[${timestamp}](${newUrl})`;
                modifiedLine = modifiedLine.substring(0, index) + 
                              replacement + 
                              modifiedLine.substring(index + fullMatch.length);
            }
        }
        
        lines[i] = modifiedLine;
    }
    
    return lines.join('\n');
};

const applyStringReplacements = (content: string): string => {
    let updatedContent = content;
	const replacements = [
		// We would convert later `(59:41, 01:00:29)` type of strings, but if it's `[59:41, 01:00:29]` with square brackets, we need to convert [ and ] to round brackets
		{
			from: /\[((\d{1,2}:\d{2})(:\d{2})?, (\d{1,2}:\d{2})(:\d{2})?)\]/g,
			to: '($1)'
		},
		// Convert TraeAI external file links to Obsidian wiki-links
		// Fix applied 070126: https://claude.ai/chat/a44bc0b7-5571-42dd-9085-c2990fc8b8bc
		{
			from: /\[([^\]]+?)\.md\]\(file:\/\/\/[^\)]*?[\/\\]([^\/\\]+?)\.md\)/g,
			to: (match, displayText, encodedFilename, offset, fullString) => {
				// Decode the filename from URL encoding
				const decodedName = decodeURIComponent(encodedFilename);
				
				// Check if link is at start of line OR after sentence-ending punctuation + space
				const charBefore = offset > 0 ? fullString.charAt(offset - 1) : '\n';
				const twoCharsBefore = offset > 1 ? fullString.substring(offset - 2, offset) : '';
				
				const isStartOfLine = charBefore === '\n' || offset === 0;
				const isAfterSentenceEnd = /[.?!"']\s$/.test(twoCharsBefore);
				
				if (isStartOfLine || isAfterSentenceEnd) {
					// No alias at sentence start
					return `[[${decodedName}]]`;
				} else {
					// Always use lowercase alias mid-sentence
					const lowercaseAlias = decodedName.charAt(0).toLowerCase() + decodedName.slice(1);
					return `[[${decodedName}|${lowercaseAlias}]]`;
				}
			}
		},
		// Convert AI IDE external links with folder paths (e.g., [Text](F/File.md)) to Obsidian wiki-links
		// Fix applied 270126: https://claude.ai/chat/4094db8c-57fd-40cb-841f-1df0d66b5923
		{
			from: /\[([^\]]+?)\]\([A-Z]\/([^\)]+?)\.md\)/g,
			to: (match, displayText, encodedFilename, offset, fullString) => {
				// Decode the filename from URL encoding (handles %20 etc.)
				const decodedName = decodeURIComponent(encodedFilename);
				
				// Check if link is at start of line OR after sentence-ending punctuation + space OR after closing parenthesis
				const charBefore = offset > 0 ? fullString.charAt(offset - 1) : '\n';
				const twoCharsBefore = offset > 1 ? fullString.substring(offset - 2, offset) : '';
				
				const isStartOfLine = charBefore === '\n' || offset === 0;
				const isAfterSentenceEnd = /[.?!"']\s$/.test(twoCharsBefore);
				const isAfterParenthesis = charBefore === ')';
				
				if (isStartOfLine || isAfterSentenceEnd || isAfterParenthesis) {
					// No alias at sentence start or after parenthesis
					return `[[${decodedName}]]`;
				} else {
					// Always use lowercase alias mid-sentence
					const lowercaseAlias = decodedName.charAt(0).toLowerCase() + decodedName.slice(1);
					return `[[${decodedName}|${lowercaseAlias}]]`;
				}
			}
		},
		// HANDLE HUNNIC KING ATILLA'S NAME WELL -- only replace his name, not names belonging to other people
		// Step 0a: Protect known exceptions who use 'Atilla' spelling
		{
			from: /\b(Grandpierre)\s+(Atill)(?=[a-záéíóöőúüű])/g,
			to: '$1 @EXCEPTION@$2'
		},
		// Step 0b: Protect "Attila Hotel" specifically
		{
			from: /\b(Attil)(?=a\s+Hotel)/g,
			to: '@HOTEL@$1'
		},
		// Step 1: Mark some place and time adverbs plus foreign names that SHOULD allow Attil->Atill conversion
		// Here it is impossible to know what comes before Attila where we SHOULD change...
		{
			from: /\b(Ahol|Amikor|Ezért|Azzal|Akkor|Aetius|Priscus|Priszkosz?|Jordanesz?|Odoaker|Odoacer|Bled|Bud|Ell[aá]k|Dengizik|Ern[aá]k|Theodosius|Valentinianus|Honorius|Marcianus|Rug|Mundzuk|Bendegúz|Orestes|Oresztész|Ricimer|Geiseric|Theodoric|Valamir)[a-záéíóöőúüű]*(\s+)(Attil)(?=[a-záéíóöőúüű])/g,
			to: '$1$2@ALLOW@$3'
		},
		// Step 2: Protect all other Name+Attil patterns (Hungarian names)
		{
			from: /\b([A-ZÁÉÍÓÖŐÚÜŰ][a-záéíóöőúüű]+)\s+(Attil)(?=[a-záéíóöőúüű])/g,
			to: '$1 @PROTECTED@$2'
		},
		// Step 3: Replace @ALLOW@ markers back to plain Attil (so they get converted in Step 4)
		{
			from: /@ALLOW@Attil/g,
			to: 'Attil'
		},
		// Step 4: Replace unprotected Attil -> Atill
		{
			from: /Attil(?=[a-záéíóöőúüű])/g,
			to: 'Atill'
		},
		// Step 5: Restore protected instances
		{
			from: /@PROTECTED@Atill/g,
			to: 'Attil'
		},
		// Step 5b: Restore Attila Hotel
		{
			from: /@HOTEL@Atill/g,
			to: 'Attil'
		},
		// Step 6: Restore exceptions (keep Atilla spelling)
		{
			from: /@EXCEPTION@Atill/g,
			to: 'Atill'
		},
        // Remove extra square brackets around timestamp links
        {
            from: /\[\[(\d{1,2}:\d{2}(?::\d{2})?)\]\((https?:\/\/[^)]+)\)\]/g,
            to: '[$1]($2)'
        },
        // Remove Python added/pasted subs custom prefacing and nothing else
        {
            from: /^# .*\r?\n.*\r?\n\*\*Video ID:\*\*.*\r?\n(?:[^\[\r\n].*\r?\n)*\r?\n---\r?\n\r?\n?/gm,
            to: '---\n\n'
        },
		// Split double timestamps in parentheses into separate brackets
        {
            from: /\((\d{1,2}:\d{2}(?::\d{2})?),\s*(\d{1,2}:\d{2}(?::\d{2})?)\)/g,
            to: '([$1]) ([$2])'
        },
        // Convert (..:..:..) to [..:..:..] in case of missing links and malformed stamps (we fix [..:..:..] to be converted to proper links elsewhere, later)
		{
            // from: /(?<!\])\(([0-9]{2}:[0-9]{2}:[0-9]{2})\)/g,
			from: /\((\d{1,2}:\d{2}(?::\d{2})?)\)/g,
			to: '[$1]'
		},
        // Remove `[&nbsp;__&nbsp;]` that makes my original subs bold
        {
            from: /\[\&nbsp;__\&nbsp;\]/g,
            to: ''
        },
        // Convert smart quotes to regular quotes
        { 
			from: /(”|“|“|”|〝|〞)/g, 
			to: '"'
		},
        {
            from: /„/g,
            to: '"'
        },
        {
            from: /<sil>/g,
            to: ''
        },
        {
            from: /(?<![Tt]he |[Mm]y |[Yy]our|[Aa] )speaker/g,
            to: 'beszélő'
        },
        {
            from: /finugor/g,
            to: 'finnugor'
        },
        {
            from: /magyarország/g,
            to: 'Magyarország'
        },
        // Remove double escapes
        {
            from: /\\\\/g,
            to: '\\'
        },
        {
            from: /negyedik béla/gi,
            to: 'IV. Béla'
        },
        {
            from: /harmadik béla/gi,
            to: 'III. Béla'
        },
        {
            from: /második andrás/gi,
            to: 'II. András'
        },
        {
            from: /Árpádház/gi,
            to: 'Árpád-ház'
        },
        {
            from: /turulház/gi,
            to: 'Turul-ház'
        },
        {
            from: /szent korona/gi,
            to: 'Szent Korona'
        },
        {
            from: /Magyarországi/g,
            to: 'magyarországi'
        },
        {
            from: /Harcburg|habsburg/gi,
            to: 'Habsburg'
        },
        {
            from: /a kiegyezés/gi,
            to: 'a Kiegyezés'
        },
        {
            from: /Kubinyi/g,
            to: 'Kubínyi'
        },
        {
            from: /Torockai/g,
            to: 'Toroczkai'
        },
        {
            from: /(Horti\s|Horty\s)/gi,
            to: 'Horthy '
        },
        {
            from: /Prónai Pál/gi,
            to: 'Prónay Pál'
        },
        {
            from: /(szent koron)/gi,
            to: 'Szent Koron'
        },
        {
            from: /(Meggyesi Péter|Medgyesi Péter|Meggyesy Péter)/gi,
            to: 'Medgyessy Péter'
        },
        {
            from: /Tököli Imre/gi,
            to: 'Thököly Imre'
        },
        {
            from: /Bakai Kornél/gi,
            to: 'Bakay Kornél'
        },
        {
            from: /(Szécsényi István)/gi,
            to: 'Széchenyi István'
        },
        {
            from: /(Najman János|Nejman János)/gi,
            to: 'Neumann János '
        },
        {
            from: /Elan Musk/gi,
            to: 'Elon Musk '
        },
        {
            from: /Antal József/gi,
            to: 'Antall József'
        },
        {
            from: /Acél Györ/gi,
            to: 'Aczél Györ'
        },
        {
            from: /Mencer Tamás/gi,
            to: 'Menczer Tamás'
        },
        {
            from: /(Frej|Frey) Tamás/gi,
            to: 'Frei Tamás'
        },
        {
            from: /Just László/gi,
            to: 'Juszt László'
        },
        {
            from: /Wölner/gi,
            to: 'Völner'
        },
        {
            from: /Türmer Gyul/gi,
            to: 'Thürmer Gyul'
        },
        {
            from: /(Zuchman Tamás)|(Zukman Tamás)/gi,
            to: 'Suchman Tamás'
        },
        {
            from: /Kum\s?bé[lr]a/gi,
            to: 'Kun Béla'
        },
        {
            from: /Kum\s?bélá/gi,
            to: 'Kun Bélá'
        },
        {
            from: /(Anzsu\s|Anzso\s|Anzsó\s)/gi,
            to: 'Anjou '
        },
        {
            from: /Csengei Dénes/gi,
            to: 'Csengey Dénes'
        },
        {
            from: /horvát fer/gi,
            to: 'Horváth Fer'
        },
        {
            from: /(Smit|Smid|Smith) Mária/gi,
            to: 'Schmidt Mária'
        },
        {
            from: /(Mincenti|Mindszenti)/gi,
            to: 'Mindszenty'
        },
        {
            from: /Német Sándor/gi,
            to: 'Németh Sándor'
        },
        {
            from: /Rákóci Ferenc/gi,
            to: 'Rákóczi Ferenc'
        },
        {
            from: /(Nemes Kürti István|Nemeskürth?i István)/gi,
            to: 'Nemeskürty István'
        },
        {
            from: /(Göc László|Göcc László)/gi,
            to: 'Götz László'
        },
        {
            from: /Erdély Zsuzsanna/gi,
            to: 'Erdélyi Zsuzsanna'
        },
        {
            from: /Korvin János/gi,
            to: 'Corvin János'
        },
        {
            from: /Tiszapárt/gi,
            to: 'Tisza Párt'
        },
        {
            from: /(Cakó Gábor|Cakógábor)/gi,
            to: 'Czakó Gábor'
        },
        {
            from: /(vasalbert|Vas Albert|Vass Albert|Albert Wass)/gi,
            to: 'Wass Albert'
        },
        {
            from: /(Nyílő József|Nyilő József)/gi,
            to: 'Nyirő József'
        },
        {
            from: /Csontvári/gi,
            to: 'Csontváry'
        },
        {
            from: /(Tormai Cécil|Tormai Cecil|Torma Cecil|Torma Cécil|Tormay Cecil|Tormay Cécil)/gi,
            to: 'Tormay Cécile'
        },
        {
            from: /Lénárt Fülöp/gi,
            to: 'Lénárd Fülöp'
        },
        {
            from: /(Túróci|Turoci) krón/gi,
            to: 'Thuróczy krón'
        },
        {
            from: /(Túróci|Turoci|Turóci|Thúróczy) János/gi,
            to: 'Thuróczy János'
        },
        {
            from: /(Verbőci|Verbőczy) István/gi,
            to: 'Werbőczy István'
        },
        {
            from: /Komoróci Géza/gi,
            to: 'Komoróczy Géza'
        },
        {
            from: /Budaházi György/gi,
            to: 'Budaházy György'
        },
        {
            from: /Csóri Sándor/gi,
            to: 'Csoóri Sándor'
        },
        {
            from: /(Józefusz|Józsefusz|Jósephus|Józephus) (Fláviusz|Flávius|Flavius)/gi,
            to: 'Josephus Flavius'
        },
        {
            from: /(Teufolaktuszimokata|Teufolaktusz szimokata)/gi,
            to: 'Teophylaktosz Simokattész'
        },
        {
            from: /[VW]itner Mári/gi,
            to: 'Wittner Mári'
        },
        {
            from: /Luke Montagnier/gi,
            to: 'Luc Montagnier'
        },
        {
            from: /(Rusin Szendi Romulus|Rusin Sandi Romulus|Rusin Sandy Romulusz|Rusin Sendi Romulus|Rusin Szendy Romulus|Rusin Sandy Romulus|Rusin Szendi Romulusz|Ruszin Szendi Romulusz|Ruszin Szendy Romulus|Ruszin Szendy Romulusz|Ruszin-Szendy Romulus|Rin Szendy Romulusz)/gi,
            to: 'Ruszin-Szendi Romulusz'
        },
        {
            from: /Dajcs Tamás/gi,
            to: 'Deutsch Tamás'
        },
        {
            from: /Berekszászi Zsolt/gi,
            to: 'Beregszászi Zsolt'
        },
        {
            from: /Neparácki Endre/gi,
            to: 'Neparáczki Endre'
        },
        {
            from: /Baktai Ervin/gi,
            to: 'Baktay Ervin'
        },
        {
            from: /(Molnár W\. József)|(Molnár Véh? József)|(Molnár Végh? József)/gi,
            to: 'Molnár V. József'
        },
        {
            from: /Cucor Gergely/gi,
            to: 'Czuczor Gergely'
        },
        {
            from: /Kiszeli István/gi,
            to: 'Kiszely István'
        },
        {
            from: /Balassi Bálint/gi,
            to: 'Balassy Bálint'
        },
        {
            from: /Érdi Miklós/gi,
            to: 'Érdy Miklós'
        },
        {
            from: /Raffai Ernő/gi,
            to: 'Raffay Ernő'
        },
        {
            from: /Tót Zoltán József/gi,
            to: 'Tóth Zoltán József'
        },
        {
            from: /szuverenitás védelmi hivatal/gi,
            to: 'Szuverenitásvédelmi Hivatal'
        },
        {
            from: /Kárpátmedenc/gi,
            to: 'Kárpát-medenc'
        },
        {
            from: /Hisztória Verisszima/gi,
            to: 'Historia Verissima'
        },
        {
            from: /anonimus/gi,
            to: 'Anonymus'
        },
        {
            from: /(Kazinci|Kazinczi|Kazincy) Ferenc/gi,
            to: 'Kazinczy Ferenc'
        },
        {
            from: /Krudinák/gi,
            to: 'Chrudinák'
        },   
        {
            from: /(\s|")balépés/gi,
            to: '$1ballépés'
        },
        {
            from: /(\s|")ésszerű/g,
            to: '$1észszerű'
        },
        {
            from: /európai\s[úÚ]nió/gi,
            to: 'Európai Únió'
        },
        {
            from: /Vörös Kereszt/gi,
            to: 'Vöröskereszt'
        },
        {
            from: /e[gk]v[aá]dor/g,
            to: 'ecuador'
        },
        {
            from: /E[gk]v[aá]dor/g,
            to: 'Ecuador'
        },
        {
            from: /fémegmunkál/g,
            to: 'fémmegmunkál'
        },
        {
            from: /Bajer Zsolt/gi,
            to: 'Bayer Zsolt'
        },
        {
            from: /pártitkár/g,
            to: 'párttitkár'
        },
        {
            from: /Grácz? Endr/gi,
            to: 'Grátz Endr'
        },
        {
            from: /Rácz? László/gi,
            to: 'Rátz László'
        },
        {
            from: /Pongrácz? Gergely/gi,
            to: 'Pongrátz Gergely'
        },
        {
            from: /Révai Péter/gi,
            to: 'Révay Péter'
        },
        {
            from: /(Krassus|Krasszusz)/gi,
            to: 'Crassus'
        },
        {
            from: /(Pe[tc]z?enhoffer Antal|Pecinh?o Hoffer Antal|Petunhoffer Antal)/gi,
            to: 'Peczenhoffer Antal'
        },
        {
            from: /maniheizmus/gi,
            to: 'manicheizmus'
        },
        {
            from: /maniheista/gi,
            to: 'manicheista'
        },
        {
            from: /(Rózsa Flores|Rózsafloresz)/gi,
            to: 'Rózsa-Flores'
        },
        {
            from: /(Barcsa Turner|Barcsaturner)/gi,
            to: 'Barcsa-Turner'
        },
        {
            from: /állellenzék/gi,
            to: 'álellenzék'
        },
        {
            from: /64 Vármegyei Ifjúsági Mozgalom/gi,
            to: '64 Vármegye Ifjúsági Mozgalom'
        },
        {
            from: /Méfi Jakab/gi,
            to: 'Méhfi Jakab'
        },
        {
            from: /Heltei Gáspár/gi,
            to: 'Heltai Gáspár'
        },
        {
            from: /(Kovid|[kc]ovid)/g,
            to: 'Covid'
        },
        {
            from: /Kónyi Kiss? Botond/gi,
            to: 'Kónyi-Kiss Botond'
        },
        {
            from: /Állos Király/gi,
            to: 'Álmos Király'
        },
        {
            from: /Demokrata Koalíció/gi,
            to: 'Demokratikus Koalíció'
        },
        {
            from: /(Szártó Péter|Szírtó Péter|Szíjjártó Péter|Szíjártó Péter|Szijártó Péter)/gi,
            to: 'Szijjártó Péter'
        },
        {
            from: /Kraszna Horkai/gi,
            to: 'Krasznahorkai'
        },
        {
            from: /Zrinyi /g,
            to: 'Zrínyi '
        },
        {
            from: /Kirityán Zsolt/gi,
            to: 'Tyirityán Zsolt'
        },
        {
            from: /(HVM|64 VMIM)/g,
            to: 'HVIM'
        },
        {
            from: /Kolonics László/gi,
            to: 'Kolonits László'
        },
        {
            from: /(Badinyi Jós|Badinyi-Jós|Badiny-Jós)/gi,
            to: 'Badiny Jós'
        },
        {
            from: /Cseber Roland/gi,
            to: 'Tseber Roland'
        },
        {
            from: /(Dérsolt|Dér Solt)/gi,
            to: 'Dér Zsolt'
        },
        {
            from: /(Kónyi Kisbotond|Kónyi Kis Botond)/gi,
            to: 'Kónyi-Kiss Botond'
        },
        {
            from: /második Rákóczi Ferenc/gi,
            to: 'II. Rákóczi Ferenc'
        },
        {
            from: /\[\.\.\.\]/gi,
            to: '\[...\]'
        },
        {
            from: /eltusol/g,
            to: 'eltussol'
        },
        {
            from: /fedhetetlen/gi,
            to: 'feddhetetlen'
        },
        {
            from: /placehooolder3/gi,
            to: 'placehooolder3'
        },
        {
            from: /placehooolder3/gi,
            to: 'placehooolder3'
        },
        {
            from: /placehooolder3/gi,
            to: 'placehooolder3'
        },
        {
            from: /placehooolder3/gi,
            to: 'placehooolder3'
        },
        {
            from: /placehooolder3/gi,
            to: 'placehooolder3'
        },
        {
            from: /\[!tipp?\]/g,
            to: '[!note]'
        },
        {
            from: /\*\*TIPPEK\*\*/g,
            to: '**FELHÍVÁS**'
        },
        {
            from: /(##?) TIPPEK/g,
            to: '$1 FELHÍVÁS'
        },
        // Exchange faulty ending bracket (sometimes when Google is fast, this error happens)
        // {
        //    from: /([0-9]{3,5})\]/g,
        //    to: '$1)'
        // },
        // Another type of this; only this needed I think
        // source: https://claude.ai/chat/791727ef-ece4-4730-b993-a4e30ed95faf
        {
            from: /(\[(?:\d{1,2}:)?\d{2}:\d{2}\]\(https?:\/\/[^)]*?)\]/g,
            to: '$1)'
        },
        // Add newlines before callouts - simplified
        {
            from: /([^\n])\n(>\s*\[!(?:check|important|fail|note|question|example)\])/g,
            to: '$1\n\n$2'
        },
        // Format callout content - simplified
        {
            from: /(>\s*\[!(?:check|important|fail|note|question|example)\])\n(>\s*)([^\n]+)(\n\n|\n$|$)/g,
            to: '$1\n> $3\n\n'
        },
        // Add 'A' articles for callouts - simplified
        {
            from: /(>\s*\[!(?:check|important|fail|note|question|example)\])\n(>\s*)([bcdfghjklmnprstvwxyz])/g,
            to: '$1\n$2A $3'
        },
        // Add 'Az' articles for callouts - simplified
        {
            from: /(>\s*\[!(?:check|important|fail|note|question|example)\])\n(>\s*)([aáeéiíoóöőuúüű])/g,
            to: '$1\n$2Az $3'
        },
		// Add 'A' articles after sentence endings - simplified
        {
            from: /([.!?])\s*\n([bcdfghjklmnprstvwxyz][^\n]*)/g,
            to: (match, p1, p2) => {
                // Skip if it's a metadata line
                if (/^(?:title|tags|source|description|processed|published|date_created|author|banner|featured_im_yt_link|featured_image|thumbnail):/i.test(p2)) {
                    return match;
                }
                return `${p1}\nA ${p2}`;
            }
        },
        // Add 'Az' articles after sentence endings - simplified
        {
            from: /([.!?])\s*\n([aáeéiíoóöőuúüű][^\n]*)/g,
            to: (match, p1, p2) => {
                // Skip if it's a metadata line
                if (/^(?:title|tags|source|description|processed|published|date_created|author|banner|featured_im_yt_linkfeatured_image|thumbnail):/i.test(p2)) {
                    return match;
                }
                return `${p1}\nAz ${p2}`;
            }
        },
        // Add 'A' articles for list items - simplified
        {
            from: /^([*-]\s*)([bcdfghjklmnprstvwxyz])/gm,
            to: (match, p1, p2) => {
                // Skip if it follows with common article patterns
                return `${p1}A ${p2}`;
            }
        },
        // Add 'Az' articles for list items - simplified
        {
            from: /^([*-]\s*)([aáeéiíoóöőuúüű])/gm,
            to: (match, p1, p2) => {
                // Skip if it follows with common article patterns
                return `${p1}Az ${p2}`;
            }
        },
        // Remove separator before GONDOLATOK section - simplified
        {
            from: /---\s*\n(GONDOLATOK|\*\*GONDOLATOK\*\*|## GONDOLATOK|# GONDOLATOK)/g,
            to: '\n$1'
        },
        // Exchange H2 with ## - simplified
        {
            from: /^H2\s/gm,
            to: '## '
        },
        // Remove bold from articles - simplified
        {
            from: /\*\*(Az|A|az|a)\*\*/g,
            to: '$1'
        },
        // Remove triple asterisks lines - simplified
        {
            from: /^\*\*\*\s*$/gm,
            to: ''
        },
        // Remove command - simplified
        {
            from: /@summarize_with_gemini.*/m,
            to: ''
        },
        // Fix double articles and capitalize existing ones in quotes
        {
            from: /(^[*-]\s*"?)(?:Az\s+a|A\s+a)\s+/gm,
            to: '$1A '
        },
        {
            from: /(^[*-]\s*"?)(?:Az\s+az|A\s+az)\s+/gm,
            to: '$1Az '
        },
        // Capitalize existing lowercase articles at quote start
        {
            from: /(^[*-]\s*"?)a\s+([bcdfghjklmnprstvwxyz])/gm,
            to: '$1A $2'
        },
        {
            from: /(^[*-]\s*"?)az\s+([aáeéiíoóöőuúüű])/gm,
            to: '$1Az $2'
        },
        // Capitalize articles after asterisks
        {
            from: /(\s*\*.*\n)(a|az)\s/g,
            to: (_, p1, p2) => `${p1}${p2[0].toUpperCase()}${p2.slice(1)} `
        },
        // Add 'A' articles for list items (only if no article exists)
        {
            from: /(^[*-]\s*)(?:")?(?!(?:A|a)\s|title:|tags:|source:|description:|published:|date)([bcdfghjklmnprstvwxyz])/gm,
            to: '$1"A $2'
        },
        // Add 'Az' articles for list items (only if no article exists)
        {
            from: /(^[*-]\s*)(?:")?(?!(?:Az|az)\s|title:|tags:|source:|description:|published:|date)([aáeéiíoóöőuúüű])/gm,
            to: '$1"Az $2'
        },
        // Add 'A' articles after '> ' in callouts
        {
            from: /(>\s+)(?!(?:A\s|a\s))([bcdfghjklmnprstvwxyz])/g,
            to: '$1A $2'
        },
        // Add 'Az' articles after '> ' in callouts
        {
            from: /(>\s+)(?!(?:Az\s|az\s))([aáeéiíoóöőuúüű])/g,
            to: '$1Az $2'
        },
        // Remove any markdown code blocks and trailing backticks
        {
            from: /```(?:markdown)?\n?([\s\S]*?)(?:```|$)/g,
            to: '$1'
        },
        // Deordinalize numbers 1,2
        {
            from: /^(>\s{1}[0-9]{1,5})([.])/gm,
            to: '$1\\$2'
        },
        {
            from: /^([0-9]{1,5})([.])/gm,
            to: '$1\\$2'
        },
        {
            from: /> - (.*)/gm,
            to: '> – $1'
        },
        {
            from: /<span style="margin-left: 2em">-/gm,
            to: '<span style="margin-left: 2em">–'
        },
        {
            from: /-(.*?Személyek)/gm,
            to: '–$1'
        },
        {
            from: /-(.*?Könyvek\/Művek\/Előadások)/gm,
            to: '–$1'
        },
        {
            from: /-(.*?Szervezetek\/Projektek)/gm,
            to: '–$1'
        },
        {
            from: /-(.*?Helyszínek)/gm,
            to: '–$1'
        },
        {
            from: /-(.*?Fogalmak\/Szimbólumok)/gm,
            to: '–$1'
        },
        {
            from: /-(.*?Inspirációk)/gm,
            to: '–$1'
        },
        {
            from: /\*\*Művek\*\*\/\*\*Előadások\*\*/gm,
            to: 'Művek/Előadások'
        },
        // Add html entity &nbsp; to have Hungarian translation of callout label only visible, not the English
        {
            from: /(\[!.+?\])(\s{0,2})\n/g,
            to: '$1 &nbsp;\n'
        },
        // Shift callout blocks one indent level to the left (SHIFT+TAB simulation)
        {
            from: /((?:^( {4}|\t)> \[!\w.*\n)(?:\2> .*\n)*)(?=\s*\n)/gm,
            to: m => m.replace(/^( {4}|\t)/gm, '')
        },
        // Change plantUML diagram colours (yeah, but we do NOT change within diagrams so these would not fire)
        // {
            // from: /f9f5d7/g,
            // to: '89c388'
        // },
        // {
            // from: /ccbe78/g,
            // to: 'b4e0b3'
        // },
        // Replace 'Unknown_Title' with actual title from YAML frontmatter (DO NOT SEEM TO BE NEEDED??)
        {
            from: /Unknown_Title/g,
            to: function(substring: string, ...args: any[]): string {
                const string = args[args.length - 1]; // Full string is always the last argument
                // Extract the title from frontmatter
                const titleMatch = string.match(/^title:\s*([^\n]+)$/m);
                if (titleMatch && titleMatch[1]) {
                    return titleMatch[1].trim();
                }
                return substring; // Keep original if no title found
            }
        },
        // Add this to the replacements array in applyStringReplacements:
        {
            from: /\[(\d{1,2}(?::\d{2}){1,2})\](?!\()/g,
            to: (match, timestamp) => {
                // Find any existing timestamp link in the content to use as template
                const templateMatch = updatedContent.match(/\[(\d{1,2}(?::\d{2}){1,2})\]\((https?:\/\/[^\s)]+)\)/);
                if (templateMatch) {
                    const [_, templateTime, templateUrl] = templateMatch;
                    // Extract base URL and time parameter
                    const urlBase = templateUrl.split('?')[0];
                    const seconds = parseTimestamp(timestamp);
                    
                    // Determine time parameter format based on URL
                    let timeParam = '';
                    if (templateUrl.includes('youtube.com') || templateUrl.includes('youtu.be')) {
                        timeParam = `?t=${seconds}`;
                    } else if (templateUrl.includes('rumble.com')) {
                        timeParam = `?start=${seconds}`;
                    } else if (templateUrl.includes('videa.hu')) {
                        timeParam = `?start=${seconds}`;
                    } else if (templateUrl.includes('bitchute.com')) {
                        timeParam = '';
                    }
                    
                    return `[${timestamp}](${urlBase}${timeParam})`;
                }
                return match; // Keep original if no template found
            }
        }
    ];

    for (const {from, to} of replacements) {
        // Convert string or regex to RegExp if needed
        const regex = from instanceof RegExp ? from : new RegExp(from);
        
        // Test if there are any matches before replacing
        if (regex.test(updatedContent)) {
            console.log(`Found matches for pattern: ${regex}`);
            // Reset regex lastIndex
            regex.lastIndex = 0;
            // Apply replacement
            updatedContent = updatedContent.replace(regex, to);
        }
    }
    
    return updatedContent;
};

interface DiagramLocation {
    diagram: string;
    position: number;
}

const extractAndRemoveDiagrams = (content: string): {
	// Fixed in https://claude.ai/chat/2583815a-11b6-4c32-a04d-bebbd04897d9
    contentWithoutDiagrams: string; 
    diagrams: DiagramLocation[] 
} => {
    const diagrams: DiagramLocation[] = [];
    
    // Match PlantUML diagrams with or without consistent blockquote prefixes
    // Captures the prefix (if any) and uses backreference to ensure consistency
    // const diagramRegex = /(?:^|\n)((?:>\s*)?)```(?:plantuml(?:-svg)?|\w*)\n?\1@start.*?uml[\s\S]*?\1@end.*?uml\n?\1```/gm;
    // fix at https://claude.ai/chat/10ddc720-e55b-4ef5-8924-b753f9a28a52
    const diagramRegex = /(?:^|\n)((?:>\s*)?)```(?:plantuml(?:-svg)?|\w*)\n?\1@start.*?uml[\s\S]*?\1@end(?:uml|umum)\n?\1```/gm;
    
    let match;
    while ((match = diagramRegex.exec(content)) !== null) {
        diagrams.push({
            diagram: match[0],
            position: match.index
        });
    }

    // Remove all diagrams from content
    const contentWithoutDiagrams = content.replace(diagramRegex, '__DIAGRAM__');
    
    return { contentWithoutDiagrams, diagrams };
};

/**
 * Parses YouTube timed text JSON format
 * Based on: https://github.com/nuhman/yt-timedtext-srt
 */
interface TimedTextSegment {
    startTimeMs: number;
    endTimeMs: number;
    text: string;
}

interface TimedTextEvent {
    tStartMs: number;
    dDurationMs: number;
    id?: number;
    wpWinPosId?: number;
    wsWinStyleId?: number;
    wWinId?: number;
    segs?: Array<{utf8: string}>;
    aAppend?: number;
}

const parseTimedTextJson = (jsonContent: string): TimedTextSegment[] => {
    try {
        const timedTextJson = JSON.parse(jsonContent);
        const events = timedTextJson.events || [];
        return getTimedTextSegments(events);
    } catch (error) {
        console.error('Error parsing timed text JSON:', error);
        return [];
    }
};

const getTimedTextSegments = (events: TimedTextEvent[]): TimedTextSegment[] => {
    const segments: TimedTextSegment[] = [];
    let segmentText = '';
    let segment: Partial<TimedTextSegment> = {
        startTimeMs: 0,
    };

    events.forEach(evt => {
        // Check whether it is manually uploaded CC or not
        if (!evt.wWinId && evt.segs) {
            segment.startTimeMs = evt.tStartMs;
            segment.endTimeMs = evt.tStartMs + evt.dDurationMs;
            (evt.segs || []).forEach(seg => {
                const text = seg.utf8;
                if (text && text !== '\n') {
                    segmentText += (text || '');
                }
            });
            segment.text = segmentText;
            segments.push(segment as TimedTextSegment);
            segment = {};
            segmentText = '';
            return;
        }

        // Below code is a fallback for Auto Generated CC
        if (!evt.aAppend) {
            segment.startTimeMs = evt.tStartMs;
            (evt.segs || []).forEach(seg => {
                const text = seg.utf8;
                if (text && text !== '\n') {
                    segmentText += (text || '');
                }
            });
        } else {
            segment.endTimeMs = evt.tStartMs;
            segment.text = segmentText;
            segments.push(segment as TimedTextSegment);
            segment = {};
            segmentText = '';
        }
    });

    return segments;
};

const convertTimedTextToMarkdown = (segments: TimedTextSegment[], videoId: string): string => {
    let markdown = '';
    
    segments.forEach(segment => {
        const seconds = Math.floor(segment.startTimeMs / 1000);
        const timestamp = secondsToTimestamp(seconds);
        const text = segment.text.trim();
        if (text) {
            markdown += `[${timestamp}](https://www.youtube.com/watch?v=${videoId}&t=${seconds}) ${text}\n`;
        }
    });
    
    return markdown;
};

const restoreDiagrams = (content: string, diagrams: DiagramLocation[]): string => {
    let result = content;
    let offset = 0;
    
    // Sort diagrams by position to restore them in order
    diagrams.sort((a, b) => a.position - b.position);
    
    // Find and replace each __DIAGRAM__ placeholder with the actual diagram
    for (const { diagram } of diagrams) {
        const placeholderIndex = result.indexOf('__DIAGRAM__', offset);
        if (placeholderIndex === -1) continue;
        
        result = result.slice(0, placeholderIndex) + 
                diagram + 
                result.slice(placeholderIndex + '__DIAGRAM__'.length);
                
        offset = placeholderIndex + diagram.length;
    }
    
    return result;
};

const transcriptSummaryCleanup = async (app: obsidian.App): Promise<void> => {
    const currentFile = app.workspace.getActiveFile();
    if (!currentFile) return;

    let fileContent = await app.vault.read(currentFile);
    
    // Fix PlantUML typos BEFORE diagram extraction - we'll do this at const diagramRegex instead
    // fileContent = fileContent.replace(/@endumum/g, '@enduml');
    // fileContent = fileContent.replace(/@startumum/g, '@startuml');
    
    // First extract and remove all PlantUML diagrams
    const { contentWithoutDiagrams, diagrams } = extractAndRemoveDiagrams(fileContent);
    fileContent = contentWithoutDiagrams;
    
    const videoId = extractVideoId(fileContent);

    let transcriptConverted = false;

    // Timed Text JSON handler: Extract raw JSON from markdown
    const wireMagicIndex = fileContent.indexOf('"wireMagic": "pb3"');
    if (wireMagicIndex !== -1 && videoId) {
        console.log('Found wireMagic marker');
        // Find the opening brace before "wireMagic"
        let braceStart = fileContent.lastIndexOf('{', wireMagicIndex);
        if (braceStart !== -1) {
            // Find the matching closing brace
            let braceCount = 1;
            let braceEnd = braceStart + 1;
            while (braceCount > 0 && braceEnd < fileContent.length) {
                if (fileContent[braceEnd] === '{') braceCount++;
                if (fileContent[braceEnd] === '}') braceCount--;
                braceEnd++;
            }
            
            if (braceCount === 0) {
                transcriptConverted = true;
                const jsonContent = fileContent.substring(braceStart, braceEnd);
                console.log('Extracted JSON, length:', jsonContent.length);
                
                try {
                    const segments = parseTimedTextJson(jsonContent);
                    console.log('Parsed segments:', segments.length);
                    if (segments.length > 0) {
                        const markdown = convertTimedTextToMarkdown(segments, videoId);
                        // Replace the JSON block with markdown
                        fileContent = fileContent.substring(0, braceStart) + 
                                     markdown + 
                                     fileContent.substring(braceEnd);
                        console.log('Converted timed text JSON to markdown');
                    }
                } catch (error) {
                    console.error('Error converting timed text JSON:', error);
                }
            }
        }
    }

    // Convert all SBV blocks to clickable lines, no wrappers
    // SBV handler: [hh:mm:ss](YouTube link) text for each SBV block
    const sbvBlockRegex = /^([\d:]+\.\d{3}),[\d:]+\.\d{3}\r?\n([\s\S]*?)(?=^[\d:]+\.\d{3},[\d:]+\.\d{3}|$)/gm;
    if (sbvBlockRegex.test(fileContent)) {
        transcriptConverted = true;
        fileContent = fileContent.replace(sbvBlockRegex, (match, timestamp, text) => {
            const seconds = Math.floor(sbvTimeToSeconds(timestamp));
            const hhmmss = secondsToTimestamp(seconds);
            const lineText = text.replace(/\r?\n/g, ' ').trim();
            return `[${hhmmss}](https://www.youtube.com/watch?v=${videoId}&t=${seconds}) ${lineText}\n`;
        });
    }

    // SRT handler: [hh:mm:ss](YouTube link) text for each SRT block
    // Matches: number line, timestamp line, text lines
    const srtBlockRegex = /^\d+\r?\n(\d{2}:\d{2}:\d{2}),\d{3} --> [^\r\n]+\r?\n([\s\S]*?)(?=^\d+\r?\n\d{2}:\d{2}:\d{2},\d{3} --> |$)/gm;
    if (srtBlockRegex.test(fileContent)) {
        transcriptConverted = true;
        fileContent = fileContent.replace(srtBlockRegex, (match, timestamp, text) => {
            // Extract the start time from the timestamp line
            const timeMatch = match.match(/^(?:\d+\r?\n)?(\d{2}:\d{2}:\d{2}),\d{3}/m);
            if (!timeMatch) return '';
            const seconds = Math.floor(srtTimeToSeconds(...timeMatch[1].split(':')));
            const hhmmss = secondsToTimestamp(seconds);
            const lineText = text.replace(/\r?\n/g, ' ').trim();
            return `[${hhmmss}](https://www.youtube.com/watch?v=${videoId}&t=${seconds}) ${lineText}\n`;
        });
    }

    // VTT handler: [hh:mm:ss](YouTube link) text for each VTT block
    // Ignores header lines (WEBVTT, Kind, Language, etc.)
    const vttHeaderRegex = /^WEBVTT[\s\S]*?(?=^\d{2}:\d{2}:\d{2}\.\d{3} --> )/m;
    if (/^WEBVTT/m.test(fileContent)) {
        transcriptConverted = true;
        // Split at WEBVTT and preserve everything above
        const webvttIdx = fileContent.indexOf('WEBVTT');
        const beforeVtt = fileContent.slice(0, webvttIdx);
        const vttAndAfter = fileContent.slice(webvttIdx);
        // Get the first three lines (WEBVTT + 2 anchor lines)
        const vttLinesArr = vttAndAfter.split(/\r?\n/);
        const anchorLines = vttLinesArr.slice(0, 3).join('\n');
        const transcriptContent = vttLinesArr.slice(3).join('\n');
        // Process transcriptContent as before
        const vttBlockRegex = /^(\d{2}:\d{2}:\d{2}\.\d{3}) --> [^\r\n]+\r?\n([\s\S]*?)(?=^\d{2}:\d{2}:\d{2}\.\d{3} --> |$)/gm;
        let vttLines: string[] = [];
        transcriptContent.replace(vttBlockRegex, (match, timestamp, text) => {
            // Convert VTT time to seconds (ignore milliseconds)
            const timeParts = timestamp.split(':');
            const seconds = Math.floor(parseInt(timeParts[0]) * 3600 + parseInt(timeParts[1]) * 60 + parseFloat(timeParts[2]));
            const hhmmss = secondsToTimestamp(seconds);
            // Remove <...> and <c>...</c> tags
            let lineText = text.replace(/<[^>]+>/g, '').replace(/\r?\n/g, ' ').trim();
            // Skip if lineText is empty
            if (!lineText) return '';
            vttLines.push(`[${hhmmss}](https://www.youtube.com/watch?v=${videoId}&t=${seconds}) ${lineText}`);
            return '';
        });
        // Remove lines that are only a clickable timestamp (no text)
        vttLines = vttLines.filter(line => !/^[\[]\d{2}:\d{2}(?::\d{2})?\][^)]*\)\s*$/.test(line));
        // Remove consecutive duplicate text lines (ignoring timestamp and link)
        let deduped: string[] = [];
        let lastText = '';
        for (const line of vttLines) {
            const textPart = line.replace(/^\[\d{2}:\d{2}(?::\d{2})?\]\([^)]*\)\s*/, '');
            if (textPart && textPart !== lastText) {
                deduped.push(line);
                lastText = textPart;
            }
        }
        // Remove double newlines from VTT conversion output (only if transcriptConverted)
        const vttOutput = deduped.join('\n');
        // Reconstruct fileContent: beforeVtt + cleaned transcript (no anchor lines)
        fileContent = beforeVtt + vttOutput + '\n';
    }

    // Remove double newlines from transcript output only if a conversion happened
    if (transcriptConverted) {
        fileContent = fileContent.replace(/(\[\d{1,2}:\d{2}(?::\d{2})?\]\([^)]*\)[^\n]*)(\n\n+)/g, '$1\n');
    }

    // Continue with the rest of the cleanup using fileContent (with diagrams removed)
    let updatedContent = applyStringReplacements(fileContent);
    updatedContent = replaceHyphensOutsideYaml(updatedContent);
    updatedContent = fixIncorrectTimestamps(updatedContent);
    const { platform, id, host } = getVideoPlatform(updatedContent);
    console.log("Detected video platform:", platform, "with ID:", id);
    if (platform && id) {
        updatedContent = fixExistingTimestampLinks(updatedContent, platform, id, host);
        updatedContent = linkUnlinkedTimestamps(updatedContent, platform, id, host);
        updatedContent = removeDuplicateTranscriptLines(updatedContent);
    }
    
    // Restore the PlantUML diagrams to their positions
    updatedContent = restoreDiagrams(updatedContent, diagrams);
    
    // Write once at the end
    await app.vault.modify(currentFile, updatedContent);
};

// Replace hyphens outside YAML blocks and only after GONDOLATOK section
const replaceHyphensOutsideYaml = (content: string): string => {
    if (!CONFIG.replaceListMarkers) {
        return content;
    }

    const yamlRegex = /^(?<![\s\S\r])(.*?)(---)([\s\S]*?)(---)/;
    const yamlMatch = content.match(yamlRegex);

    const applyReplacements = (text: string) => {
        // Find GONDOLATOK section
        const gondolatokMatch = text.match(/(# GONDOLATOK|\*\*GONDOLATOK\*\*|# Gondolatok|\*\*Gondolatok\*\*)/);
        
        if (!gondolatokMatch) {
            // No GONDOLATOK section, return unchanged
            return text;
        }
        
        const gondolatokIndex = gondolatokMatch.index!;
        const beforeGondolatok = text.substring(0, gondolatokIndex);
        const gondolatokAndAfter = text.substring(gondolatokIndex);
        
        // Apply replacements only to GONDOLATOK section and after
        const processedGondolatok = CONFIG.listMarkerReplacements.reduce((result, pattern) => {
            return result.replace(pattern.from, pattern.to);
        }, gondolatokAndAfter);
        
        return beforeGondolatok + processedGondolatok;
    };

    if (!yamlMatch) {
        return applyReplacements(content);
    }

    const yamlPart = yamlMatch[0];
    const contentPart = content.slice(yamlMatch[0].length);
    
    return yamlPart + applyReplacements(contentPart);
};

// --- SUBTITLE TO MARKDOWN CONVERTER ---

/**
 * Converts SBV or SRT subtitle content to Markdown with clickable YouTube timestamps.
 * @param subtitleContent The subtitle file content as a string.
 * @param videoId The YouTube video ID.
 * @returns Markdown string with clickable timestamps.
 */
function subtitleToMarkdown(subtitleContent: string, videoId: string): string {
    // Detect format
    const isSBV = /^([\d:]+\.\d{3}),([\d:]+\.\d{3})$/m.test(subtitleContent);
    const isSRT = /^\d+\r?\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/m.test(subtitleContent);
    const isVTT = /^WEBVTT/m.test(subtitleContent);
    console.log('Format detection:', { isSBV, isSRT, isVTT });
    if (isVTT) {
        return '\n<!-- [subtitle2md: VTT format not supported] -->\n';
    }
    let lines: string[] = subtitleContent.split(/\r?\n/);
    let blocks: { start: number, text: string }[] = [];
    if (isSBV) {
        // SBV: match any time format with colons and milliseconds
        let i = 0;
        while (i < lines.length) {
            const timeMatch = lines[i].match(/^([\d:]+\.\d{3}),([\d:]+\.\d{3})$/);
            if (timeMatch) {
                console.log('SBV time match:', lines[i]);
                const start = sbvTimeToSeconds(timeMatch[1]);
                let text = '';
                i++;
                while (i < lines.length && lines[i].trim() !== '') {
                    text += (text ? ' ' : '') + lines[i].trim();
                    i++;
                }
                blocks.push({ start, text });
            }
            i++;
        }
        console.log('SBV blocks:', blocks);
    } else if (isSRT) {
        // SRT: 1\n00:00:03,679 --> 00:00:08,320\ntext\ntext\n\n
        let i = 0;
        while (i < lines.length) {
            // Block number
            if (/^\d+$/.test(lines[i])) {
                i++;
                const timeMatch = lines[i] && lines[i].match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/);
                if (timeMatch) {
                    console.log('SRT time match:', lines[i]);
                    const start = srtTimeToSeconds(timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4]);
                    i++;
                    let text = '';
                    while (i < lines.length && lines[i].trim() !== '') {
                        text += (text ? ' ' : '') + lines[i].trim();
                        i++;
                    }
                    blocks.push({ start, text });
                }
            }
            i++;
        }
        console.log('SRT blocks:', blocks);
    } else {
        console.log('Unknown subtitle format.');
        return '\n<!-- [subtitle2md: Unknown subtitle format] -->\n';
    }
    // Output markdown
    let md = '\n<!-- [subtitle2md: begin] -->\n';
    for (const block of blocks) {
        md += `[${secondsToTimestamp(block.start)}](https://www.youtube.com/watch?v=${videoId}&t=${block.start}) ${block.text}\n`;
    }
    md += '\n<!-- [subtitle2md: end] -->\n';
    console.log('Generated Markdown:', md);
    return md;
}

function sbvTimeToSeconds(time: string): number {
    // Handles SS.mmm, M:SS.mmm, MM:SS.mmm, H:MM:SS.mmm
    const parts = time.split(':');
    if (parts.length === 3) {
        return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2].replace(',', '.'));
    } else if (parts.length === 2) {
        return parseInt(parts[0]) * 60 + parseFloat(parts[1].replace(',', '.'));
    } else if (parts.length === 1) {
        return parseFloat(parts[0].replace(',', '.'));
    }
    return 0;
}

function srtTimeToSeconds(hh: string, mm: string, ss: string, ms: string): number {
    return parseInt(hh) * 3600 + parseInt(mm) * 60 + parseInt(ss);
}

export class TranscriptSummaryCleanupPlugin extends obsidian.Plugin {
    async onload() {
        this.addCommand({
            id: 'transcript-summary-cleanup',
            name: 'Transcript Summary Cleanup',
            callback: async () => await transcriptSummaryCleanup(this.app)
        });
    }
}

export async function invoke(app: obsidian.App): Promise<void> {
    return transcriptSummaryCleanup(app);
}
