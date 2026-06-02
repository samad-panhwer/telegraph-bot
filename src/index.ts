import { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { PrismaClient } from '@prisma/client';
import cron from 'node-cron';
import { config } from 'dotenv';

config();
const prisma = new PrismaClient();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

// 1. Define Commands
const commands = [
    new SlashCommandBuilder()
        .setName('in')
        .setDescription('Clock in')
        .addStringOption(opt => opt.setName('task').setDescription('What are you doing?').setRequired(true)),
    new SlashCommandBuilder().setName('out').setDescription('Clock out'),
].map(command => command.toJSON());

// 2. Bot Logic
client.once('ready', async () => {
    console.log(`Logged in as ${client.user?.tag}`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID!, process.env.GUILD_ID!), { body: commands });
    
    // Daily Summary Job (11:59 PM PKT)
    cron.schedule('59 23 * * *', async () => {
        const channel = client.channels.cache.get(process.env.SUMMARY_CHANNEL_ID!) as any;
        const sessions = await prisma.session.findMany({
            where: { startTime: { gte: new Date(new Date().setHours(0,0,0,0)) } },
            include: { user: true }
        });
        const summary = sessions.map(s => `**${s.user.username}**: ${s.task} (${Math.round(s.durationMins || 0)}m)`).join('\n');
        channel?.send({ embeds: [new EmbedBuilder().setTitle("Daily Summary").setDescription(summary || "No work today")] });
    }, { timezone: "Asia/Karachi" });
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.channelId !== process.env.DEV_CHANNEL_ID) {
        return interaction.reply({ content: "Wrong channel!", ephemeral: true });
    }

    const { commandName, user } = interaction;

    if (commandName === 'in') {
        const task = interaction.options.getString('task')!;
        const dbUser = await prisma.user.upsert({
            where: { discordId: user.id },
            update: { username: user.username },
            create: { discordId: user.id, username: user.username }
        });

        await prisma.session.create({ data: { userId: dbUser.id, task } });
        await interaction.reply(`🚀 **${user.username}** clocked in: ${task}`);
    }

    if (commandName === 'out') {
        const session = await prisma.session.findFirst({
            where: { user: { discordId: user.id }, isActive: true }
        });

        if (!session) return interaction.reply("You aren't clocked in!");

        const duration = Math.round((new Date().getTime() - session.startTime.getTime()) / 60000);
        await prisma.session.update({
            where: { id: session.id },
            data: { isActive: false, endTime: new Date(), durationMins: duration }
        });

        await interaction.reply(`✅ **${user.username}** clocked out. Worked: ${duration} minutes.`);
    }
});

client.login(process.env.DISCORD_TOKEN);