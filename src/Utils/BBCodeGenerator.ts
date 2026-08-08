export type GeneratorTheme = 'forum_post' | 'beatmap_desc' | 'random_chat'

export class BBCodeGenerator {
  // ── Osu! Dictionaries ──
  private nouns = ['beatmap', 'circles', 'sliders', 'streams', 'jumps', 'combo', 'PP', 'rank', 'choke', 'mods', 'FC', 'spinner', 'accuracy', 'cursor']
  private adjectives = ['hard', 'insane', 'unranked', 'ranked', 'loved', 'fast', 'tricky', 'technical', 'smooth', 'impossible']
  private verbs = ['click', 'hit', 'miss', 'retry', 'pass', 'fail', 'spin', 'farm']
  private players = ['peppy', 'Cookiezi', 'mrekk', 'Vaxei', 'WhiteCat', 'BTMC']
  private colors = ['red', 'blue', 'green', 'purple', '#FF5555', '#55FF55']

  private randomInt(max: number): number {
    return Math.floor(Math.random() * max)
  }

  private pick<T>(arr: T[]): T {
    return arr[this.randomInt(arr.length)]
  }

  // ── Basic Text Generators ──

  private generateSentence(): string {
    const templates = [
      `I just got a ${this.pick(this.adjectives)} ${this.pick(this.nouns)} on this map!`,
      `Why are the ${this.pick(this.nouns)} so ${this.pick(this.adjectives)} here?`,
      `Don't forget to ${this.pick(this.verbs)} the ${this.pick(this.nouns)}...`,
      `${this.pick(this.players)} could probably ${this.pick(this.verbs)} this with HardRock.`,
      `My ${this.pick(this.nouns)} is completely ruined after that ${this.pick(this.nouns)}.`
    ]
    return this.pick(templates)
  }

  private generateParagraph(sentences: number = 3): string {
    let p = ''
    for (let i = 0; i < sentences; i++) {
      p += this.generateSentence() + ' '
    }
    return p.trim()
  }

  // ── Formatted Blocks ──

  private generateHeading(level: 1 | 2 | 3 = 1): string {
    const text = `${this.pick(this.adjectives)} ${this.pick(this.nouns)}!`
    const size = level === 1 ? 150 : level === 2 ? 120 : 100
    return `[size=${size}][b]${text.toUpperCase()}[/b][/size]`
  }

  private generateHighlight(): string {
    return `[color=${this.pick(this.colors)}][b]${this.generateSentence()}[/b][/color]`
  }

  private generateList(items: number = 3): string {
    let list = '[list]\n'
    for (let i = 0; i < items; i++) {
      list += `[*] ${this.pick(this.adjectives)} ${this.pick(this.nouns)}\n`
    }
    list += '[/list]'
    return list
  }

  private generateNotice(): string {
    return `[notice]\n[b]Update:[/b] ${this.generateSentence()}\n[/notice]`
  }

  private generateBox(): string {
    return `[box=${this.pick(this.nouns)} details]\n${this.generateParagraph(2)}\n[/box]`
  }

  // ── High-Level Document Templates ──

  public generate(theme: GeneratorTheme = 'forum_post'): string {
    switch (theme) {
      case 'forum_post': return this.generateForumPost()
      case 'beatmap_desc': return this.generateBeatmapDesc()
      case 'random_chat': return this.generateRandomChat()
    }
  }

  private generateForumPost(): string {
    return `
${this.generateHeading(1)}

Hey everyone! 
${this.generateParagraph(3)}

${this.generateHighlight()}

Here is what I think about the ${this.pick(this.nouns)}:
${this.generateList(4)}

${this.generateBox()}

Thanks for reading!
[i]- ${this.pick(this.players)}[/i]
    `.trim()
  }

  private generateBeatmapDesc(): string {
    return `
[center]
${this.generateHeading(1)}
[i]Mapped by ${this.pick(this.players)}[/i]
[/center]

${this.generateNotice()}

[size=120][b]Difficulties[/b][/size]
${this.generateList(3)}

[size=120][b]Modding[/b][/size]
${this.generateParagraph(2)}
If you want to mod, please focus on the ${this.pick(this.adjectives)} ${this.pick(this.nouns)}.

[color=#888888]Enjoy the map![/color]
    `.trim()
  }

  private generateRandomChat(): string {
    return `
[b]PlayerA:[/b] omg I just had a ${this.pick(this.adjectives)} ${this.pick(this.nouns)}
[b]PlayerB:[/b] lol really? did you ${this.pick(this.verbs)} it?
[b]PlayerA:[/b] no... ${this.generateHighlight()}
[b]PlayerB:[/b] rip your ${this.pick(this.nouns)}.
    `.trim()
  }
}
