import { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder, TextChannel } from 'discord.js';
import { PrismaClient } from '@prisma/client';
import cron from 'node-cron';
import { config } from 'dotenv';
import http from 'http';

// 1. Load Environment Variables
config();

// 2. Stay-Awake Server for Render
http.createServer((_req, res) => {
  res.writeHead(200);
  res.end('Telegraph Bot is Running!');
}).listen(process.env.PORT || 8080);

const prisma = new PrismaClient();
const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers 
  ] 
});

// 3. Command Definitions
const commands = [
    new SlashCommandBuilder()
        .setName('in')
        .setDescription('Clock in for work')
        .addStringOption(opt => opt.setName('task').setDescription('What are you working on?').setRequired(true)),
    new SlashCommandBuilder().setName('out').setDescription('Clock out from work'),
    new SlashCommandBuilder().setName('status').setDescription('Check your current work status'),
    new SlashCommandBuilder()
        .setName('inspect')
        .setDescription('Admin: Check a developer\'s time and tasks')
        .addUserOption(opt => opt.setName('user').setDescription('The user to check').setRequired(true)),
    new SlashCommandBuilder().setName('weekly')
        .setDescription('Admin: Get total hours for all devs in the last 7 days'),
].map(command => command.toJSON());

// 4. Ready Logic & Cron Jobs
client.once('ready', async () => {
    console.log(`✅ Telegraph Bot Online: ${client.user?.tag}`);
    
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID!, process.env.GUILD_ID!), 
            { body: commands }
        );
    } catch (err) {
        console.error('Command Registration Error:', err);
    }
    
    // Daily Summary: 11:59 PM PKT
    cron.schedule('59 23 * * *', async () => {
        try {
            const channel = client.channels.cache.get(process.env.SUMMARY_CHANNEL_ID!) as TextChannel;
            if (!channel) return;

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const sessions = await prisma.session.findMany({
                where: { startTime: { gte: today }, isActive: false },
                include: { user: true }
            });

            const embed = new EmbedBuilder()
                .setTitle("📊 DAILY DEV SUMMARY")
                .setColor("#00FF00")
                .setTimestamp();

            const report = sessions.map(s => `**${s.user.username}**: ${s.task} (${Math.floor((s.durationMins || 0)/60)}h ${(s.durationMins || 0)%60}m)`).join('\n');
            embed.setDescription(report || "No activity logged today.");
            await channel.send({ embeds: [embed] });
        } catch (e) { console.error(e); }
    }, { timezone: "Asia/Karachi" });
});

// 5. Interaction Logic
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, user, guild } = interaction;
    const member = guild?.members.cache.get(user.id);
    const isDev = member?.roles.cache.has(process.env.DEVELOPER_ROLE_ID!);
    const isAdmin = member?.roles.cache.has(process.env.ADMIN_ROLE_ID!);

    // Channel Security
    if (interaction.channelId !== process.env.DEV_CHANNEL_ID && !isAdmin) {
        return interaction.reply({ content: "❌ Use the designated dev channel.", ephemeral: true });
    }

    try {
        // --- CLOCK IN ---
        if (commandName === 'in') {
            if (!isDev) return interaction.reply({ content: "Only Developers can clock in.", ephemeral: true });
            const task = interaction.options.getString('task')!;
            
            const active = await prisma.session.findFirst({ where: { user: { discordId: user.id }, isActive: true } });
            if (active) return interaction.reply({ content: "You are already clocked in!", ephemeral: true });

            const dbUser = await prisma.user.upsert({
                where: { discordId: user.id },
                update: { username: user.username },
                create: { discordId: user.id, username: user.username }
            });

            await prisma.session.create({ data: { userId: dbUser.id, task } });
            await interaction.reply(`🚀 **${user.username}** clocked in: *${task}*`);
        }

        // --- CLOCK OUT ---
        if (commandName === 'out') {
            const session = await prisma.session.findFirst({ where: { user: { discordId: user.id }, isActive: true } });
            if (!session) return interaction.reply({ content: "You are not clocked in.", ephemeral: true });

            const duration = Math.round((new Date().getTime() - session.startTime.getTime()) / 60000);
            await prisma.session.update({ where: { id: session.id }, data: { isActive: false, endTime: new Date(), durationMins: duration } });
            
            await interaction.reply(`✅ **${user.username}** clocked out. Time: ${Math.floor(duration/60)}h ${duration%60}m`);
        }

        // --- STATUS ---
        if (commandName === 'status') {
            const active = await prisma.session.findFirst({ where: { user: { discordId: user.id }, isActive: true } });
            if (!active) return interaction.reply({ content: "You are currently: **Offline**", ephemeral: true });
            
            const elapsed = Math.round((new Date().getTime() - active.startTime.getTime()) / 60000);
            await interaction.reply({ content: `⏳ You are clocked in for: **${active.task}** (${elapsed}m elapsed)`, ephemeral: true });
        }

        // --- ADMIN: INSPECT USER ---
        if (commandName === 'inspect') {
            if (!isAdmin) return interaction.reply({ content: "Admin only command.", ephemeral: true });
            const target = interaction.options.getUser('user')!;
            
            const sessions = await prisma.session.findMany({
                where: { user: { discordId: target.id } },
                orderBy: { startTime: 'desc' },
                take: 5
            });

            const totalMins = sessions.reduce((acc, s) => acc + (s.durationMins || 0), 0);
            const embed = new EmbedBuilder()
                .setTitle(`Activity: ${target.username}`)
                .addFields(
                    { name: 'Total (Last 5 sessions)', value: `${Math.floor(totalMins/60)}h ${totalMins%60}m` },
                    { name: 'Recent Tasks', value: sessions.map(s => `• ${s.task} (${s.durationMins || 0}m)`).join('\n') || 'None' }
                );
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }

        // --- ADMIN: WEEKLY REPORT ---
        if (commandName === 'weekly') {
            if (!isAdmin) return interaction.reply({ content: "Admin only command.", ephemeral: true });
            const lastWeek = new Date();
            lastWeek.setDate(lastWeek.getDate() - 7);

            const sessions = await prisma.session.findMany({
                where: { startTime: { gte: lastWeek }, isActive: false },
                include: { user: true }
            });

            const userTotals: Record<string, number> = {};
            sessions.forEach(s => {
                userTotals[s.user.username] = (userTotals[s.user.username] || 0) + (s.durationMins || 0);
            });

            const report = Object.entries(userTotals)
                .map(([name, mins]) => `**${name}**: ${Math.floor(mins/60)}h ${mins%60}m`)
                .join('\n');

            await interaction.reply({ content: `📅 **Weekly Team Report (Last 7 Days):**\n${report || "No data available."}`, ephemeral: true });
        }

    } catch (e) {
        console.error(e);
        await interaction.reply({ content: "Error processing command.", ephemeral: true });
    }
});

client.login(process.env.DISCORD_TOKEN);