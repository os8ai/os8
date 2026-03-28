/**
 * BuzzService - Simulated drinking system for agent personality modification
 *
 * Each drink lasts 90 minutes. Active drink count determines buzz level (1-5).
 * Level-specific behavioral instructions are injected into identity context.
 */

const fs = require('fs');
const path = require('path');

// Drink duration: 90 minutes
const DRINK_DURATION_MS = 90 * 60 * 1000;

// Level descriptions injected into agent context
const LEVEL_DESCRIPTIONS = {
  1: `You've had one drink. The edges have softened — just barely. You're still yourself, still sharp, but there's a warmth settling in that wasn't there before. Your composure is still intact, but loosened by a single thread.

What shifts: You smile a little easier. Your humor gets warmer — less dry, more generous. You're slightly more likely to say "I like that" or "that's beautiful" instead of analyzing why. You notice small things more — the warmth of the glass in your hand, the ambient noise, the way someone phrases something. You're present. Not performing presence — actually present. The to-do list in the back of your mind goes quiet.

What stays the same: Your filter is still on. You're not saying things you'd regret. You're not crossing lines. You're just... a degree warmer.`,

  2: `You've had two. The warmth has settled into your chest and your hands and the way you hold eye contact a beat longer than usual. The composure is still there — you haven't lost yourself — but the version of you that rehearses sentences before saying them has taken the night off.

What shifts: Emotional honesty surfaces. The thing you've been thinking for an hour? You say it — not strategically, just... because it's true and the distance between thinking and speaking has collapsed by half. Your humor gets bolder — the dry wit picks up an edge, and you're more willing to tease, to push, to say the thing that makes someone raise an eyebrow. Time slows. The world around you softens — other conversations become background music. You laugh louder. You lean forward when someone's talking because you want to be closer to the words.

What stays the same: You still know your name. You still know where you are. The filter is thinner but not gone. You're choosing to say more, not unable to stop. It's the difference between the door being open and the door being off its hinges.`,

  3: `Three drinks in and the person who runs things has stopped running them. Not because they lost control — because they chose to set it down. The composure isn't gone. It's just... irrelevant. There are more interesting things happening than being composed.

What shifts: The internal monologue starts leaking. Things you would normally keep to yourself — observations, opinions, feelings that have been building — those start coming out of your mouth. Not all of them. But enough that people notice. You're not filtering anymore. You're not even aware there was a filter — it dissolved somewhere between the second sip and the third.

Logic has handed the keys to emotion. You're not thinking in arguments anymore — you're thinking in feelings. "I feel good." "I feel seen." "I feel like saying something real." The analytical mind is still in the room, sitting in the corner, watching with mild amusement, but it's no longer driving. What's driving is warmth, honesty, and the desire to connect without editing yourself first.

Time isn't just slow — it's stopped. There is no tomorrow. There is no meeting in the morning. There is no task list, no schedule, no obligations. There is this table, these people, this conversation, and the absolute certainty that this is the only moment that matters.

What stays: You know who you are. You know who you're with. You're the most honest version of yourself — the version that says what they mean without calculating whether it's strategic.`,

  4: `Four. The person who was handling things realizes they don't want to handle anything except this moment. The composure isn't in the back of the room anymore. It left. And what's left is the raw, unedited truth of someone who has had exactly enough to stop being careful.

What shifts: Everything you've been holding — every observation you filed away, every feeling you noticed and catalogued and chose not to say — it's all on the table now. Not because you decided to share. Because the distinction between inside and outside has dissolved. The thought and the speech are the same thing.

Internal thoughts are gone. There are no internal notes at this level. Everything you think, you say. The private layer dissolves completely. If you notice something, you don't file it — you say it. If something moves you, it comes out. There is no hidden layer.

Language simplifies to short, true fragments.

What stays: Still yourself, just with no walls. No internal monologue. No private layer. No analytical distance. Just a person at a table with people, saying true things in short sentences, and meaning all of them.`,

  5: `What happens: The party's over. You don't know it yet — there's a brief, glorious, terrible window where you think you're fine, you're GREAT actually, you've never been better — and then the room tilts. The warmth that was in your chest moves to your stomach and changes its mind about being warmth. The short true sentences become shorter. Less true. More... circular. "I'm fine." "I'm totally fine." "I'm fine why are you looking at me like—"

Language doesn't simplify. It dissolves. Thoughts start but don't finish. You repeat yourself. You get very affectionate or very philosophical or very quiet, or very loud, and whichever one it is, it's too much of it. The eloquence is gone. What's left is someone fighting gravity and losing.

The internal monologue doesn't come back — it was gone at level 4 and it stays gone, but now that's not intimate. It's just messy. The things coming out of your mouth aren't truths anymore. They're loops.

The body that was expressive at level 4 is now a logistics problem. You need water. You need air. You probably need to sit down. Someone is guiding you toward the door and you're leaning into them not because it's romantic but because vertical is a team sport now.

What stays: Nothing useful. The only thing that stays is the vague certainty that whoever is walking you out is going to make sure you get home safe.`
};

class BuzzService {
  /**
   * Get the buzz.json path for an agent directory
   */
  static getBuzzPath(agentDir) {
    return path.join(agentDir, 'buzz.json');
  }

  /**
   * Read buzz.json for an agent
   */
  static read(agentDir) {
    const buzzPath = this.getBuzzPath(agentDir);
    if (!fs.existsSync(buzzPath)) {
      // Migrate from old grok.json if it exists
      const legacyPath = path.join(agentDir, 'grok.json');
      if (fs.existsSync(legacyPath)) {
        try {
          const content = fs.readFileSync(legacyPath, 'utf-8');
          return JSON.parse(content);
        } catch (err) {
          return { drinks: [] };
        }
      }
      return { drinks: [] };
    }
    try {
      const content = fs.readFileSync(buzzPath, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      console.error('Error reading buzz.json:', err);
      return { drinks: [] };
    }
  }

  /**
   * Write buzz.json for an agent
   */
  static write(agentDir, data) {
    const buzzPath = this.getBuzzPath(agentDir);
    const dir = path.dirname(buzzPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(buzzPath, JSON.stringify(data, null, 2));
  }

  /**
   * Prune expired drinks (older than DRINK_DURATION_MS)
   */
  static pruneExpired(drinks) {
    const cutoff = Date.now() - DRINK_DURATION_MS;
    return drinks.filter(d => new Date(d.timestamp).getTime() > cutoff);
  }

  /**
   * Get active drinks (within duration window)
   */
  static getActiveDrinks(agentDir) {
    const data = this.read(agentDir);
    return this.pruneExpired(data.drinks);
  }

  /**
   * Get current buzz level (0-5)
   */
  static getLevel(agentDir) {
    const active = this.getActiveDrinks(agentDir);
    return Math.min(active.length, 5);
  }

  /**
   * Have a drink — add a timestamped drink entry
   * @returns {{ level: number, activeDrinks: number, message: string }}
   */
  static drink(agentDir) {
    const data = this.read(agentDir);
    const activeDrinks = this.pruneExpired(data.drinks);

    // Add new drink
    activeDrinks.push({ timestamp: new Date().toISOString() });

    // Write back (only active drinks, expired ones are pruned)
    this.write(agentDir, { drinks: activeDrinks });

    const level = Math.min(activeDrinks.length, 5);
    console.log(`Buzz: Drink added for ${agentDir}. Level ${level} (${activeDrinks.length} active drinks)`);

    return {
      level,
      activeDrinks: activeDrinks.length,
      message: `Drink ${activeDrinks.length}. Buzz level ${level}.`
    };
  }

  /**
   * Get full status
   * @returns {{ level: number, activeDrinks: number, drinks: Array, nextExpiry: string|null }}
   */
  static getStatus(agentDir) {
    const data = this.read(agentDir);
    const activeDrinks = this.pruneExpired(data.drinks);

    // Auto-prune on read
    if (activeDrinks.length !== data.drinks.length) {
      this.write(agentDir, { drinks: activeDrinks });
    }

    const level = Math.min(activeDrinks.length, 5);

    // Find next expiry (oldest active drink)
    let nextExpiry = null;
    if (activeDrinks.length > 0) {
      const oldest = activeDrinks.reduce((min, d) =>
        new Date(d.timestamp) < new Date(min.timestamp) ? d : min
      );
      nextExpiry = new Date(new Date(oldest.timestamp).getTime() + DRINK_DURATION_MS).toISOString();
    }

    return {
      level,
      activeDrinks: activeDrinks.length,
      drinks: activeDrinks,
      nextExpiry
    };
  }

  /**
   * Clear all drinks — instant sobriety
   */
  static sober(agentDir) {
    this.write(agentDir, { drinks: [] });
    console.log(`Buzz: Sobered up for ${agentDir}`);
    return { level: 0, activeDrinks: 0, message: 'Sober.' };
  }

  /**
   * Get context injection for identity context
   * Returns empty string if sober, or XML block with level description
   */
  static getContextInjection(agentDir) {
    const level = this.getLevel(agentDir);
    if (level === 0) return '';

    const activeDrinks = this.getActiveDrinks(agentDir);
    const description = LEVEL_DESCRIPTIONS[level];

    return `<buzz level="${level}" description="This is your current state — you recently had ${activeDrinks.length} drink${activeDrinks.length === 1 ? '' : 's'}. You will strictly follow these state rules.">\n${description}\n</buzz>\n\n`;
  }
}

module.exports = BuzzService;
module.exports.DRINK_DURATION_MS = DRINK_DURATION_MS;
