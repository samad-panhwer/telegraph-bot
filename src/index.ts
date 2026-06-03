import { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder, TextChannel } from 'discord.js';
import { PrismaClient } from '@prisma/client';
import cron from 'node-cron';
import { config } from 'dotenv';
import http from 'http';

// 1. Load Environment Variables
config();

// 2. IMMEDIATE PORT BINDING (Render Requirement)
const PORT = process.env.PORT || 10000;
http.createServer((_req, res) => {
    res.writeHead(200);
    res.end('Telegraph Protocol Bot: System Online');
}).listen(Number(PORT), '0.0.0.0', () => {
    console.log(`🌍 Health check server live on port ${PORT}`);
});

// 3. Initialize Prisma & Discord Client
const prisma = new PrismaClient();
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers 
    ] 
});

// 4. Command Definitions
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

// 5. Consolidated Initialization Logic
client.once('ready', async (c) => {
    console.log(`✅ Telegraph Bot Online: ${c.user.tag}`);
    
    // Register Slash Commands
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID!, process.env.GUILD_ID!), 
            { body: commands }
        );
        console.log('✅ Slash Commands Registered Successfully');
    } catch (err) {
        console.error('❌ Command Registration Error:', err);
    }
    
    // Daily Summary Job (11:59 PM Asia/Karachi)
    cron.schedule('59 23 * * *', async () => {
        try {
            console.log('Running Daily Summary Job...');
            const channel = client.channels.cache.get(process.env.SUMMARY_CHANNEL_ID!) as TextChannel;
            if (!channel) {
                console.error('❌ Summary channel not found');
                return;
            }

            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const sessions = await prisma.session.findMany({
                where: { startTime: { gte: today }, isActive: false },
                include: { user: true }
            });

            const embed = new EmbedBuilder()
                .setTitle("📊 DAILY DEV SUMMARY")
                .setColor("#5865F2")
                .setTimestamp();

            const report = sessions.map(s => 
                `**${s.user.username}**: ${s.task} \n⏱️ ${Math.floor((s.durationMins || 0)/60)}h ${(s.durationMins || 0)%60}m`
            ).join('\n\n');

            embed.setDescription(report || "No activity logged today.");
            await channel.send({ embeds: [embed] });
        } catch (err) {
            console.error('❌ Cron Job Error:', err);
        }
    }, { timezone: "Asia/Karachi" });
});

// 6. Interaction Handling
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, user, guild } = interaction;
    const member = guild?.members.cache.get(user.id);
    
    const isDev = member?.roles.cache.has(process.env.DEVELOPER_ROLE_ID!);
    const isAdmin = member?.roles.cache.has(process.env.ADMIN_ROLE_ID!);

    if (interaction.channelId !== process.env.DEV_CHANNEL_ID && !isAdmin) {
        return interaction.reply({ content: "❌ Please use the designated dev channel.", ephemeral: true });
    }

    try {
        if (commandName === 'in') {
            if (!isDev) return interaction.reply({ content: "❌ Only Developers can clock in.", ephemeral: true });
            const task = interaction.options.getString('task')!;

            const active = await prisma.session.findFirst({ where: { user: { discordId: user.id }, isActive: true } });
            if (active) return interaction.reply({ content: "❌ You are already clocked in!", ephemeral: true });

            const dbUser = await prisma.user.upsert({
                where: { discordId: user.id },
                update: { username: user.username },
                create: { discordId: user.id, username: user.username }
            });

            await prisma.session.create({ data: { userId: dbUser.id, task } });
            await interaction.reply(`🚀 **${user.username}** clocked in: *${task}*`);
        }

        if (commandName === 'out') {
            const session = await prisma.session.findFirst({ where: { user: { discordId: user.id }, isActive: true } });
            if (!session) return interaction.reply({ content: "❌ You are not currently clocked in.", ephemeral: true });

            const duration = Math.round((new Date().getTime() - session.startTime.getTime()) / 60000);
            await prisma.session.update({ 
                where: { id: session.id }, 
                data: { isActive: false, endTime: new Date(), durationMins: duration } 
            });

            await interaction.reply(`✅ **${user.username}** clocked out. Total time: **${Math.floor(duration/60)}h ${duration%60}m**`);
        }

        if (commandName === 'status') {
            const active = await prisma.session.findFirst({ where: { user: { discordId: user.id }, isActive: true } });
            if (!active) return interaction.reply({ content: "🔴 Status: **Offline**", ephemeral: true });
            
            const elapsed = Math.round((new Date().getTime() - active.startTime.getTime()) / 60000);
            await interaction.reply({ content: `⏳ Status: **Clocked In**\n**Task:** ${active.task}\n**Time so far:** ${Math.floor(elapsed/60)}h ${elapsed%60}m`, ephemeral: true });
        }

        if (commandName === 'inspect') {
            if (!isAdmin) return interaction.reply({ content: "❌ Admin only command.", ephemeral: true });
            const target = interaction.options.getUser('user')!;
            
            const sessions = await prisma.session.findMany({
                where: { user: { discordId: target.id } },
                orderBy: { startTime: 'desc' },
                take: 5
            });

            const totalMins = sessions.reduce((acc, s) => acc + (s.durationMins || 0), 0);
            const embed = new EmbedBuilder()
                .setTitle(`Developer Profile: ${target.username}`)
                .setColor("#5865F2")
                .addFields(
                    { name: 'Last 5 Sessions Total', value: `${Math.floor(totalMins/60)}h ${totalMins%60}m`, inline: false },
                    { name: 'Recent Activity', value: sessions.map(s => `• ${s.task} (${s.durationMins || 0}m)`).join('\n') || 'No data found.' }
                );
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }

        if (commandName === 'weekly') {
            if (!isAdmin) return interaction.reply({ content: "❌ Admin only command.", ephemeral: true });
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

            const sessions = await prisma.session.findMany({
                where: { startTime: { gte: sevenDaysAgo }, isActive: false },
                include: { user: true }
            });

            const userTotals: Record<string, number> = {};
            sessions.forEach(s => {
                userTotals[s.user.username] = (userTotals[s.user.username] || 0) + (s.durationMins || 0);
            });

            const reportText = Object.entries(userTotals)
                .map(([name, mins]) => `**${name}**: ${Math.floor(mins/60)}h ${mins%60}m`)
                .join('\n');

            await interaction.reply({ content: `📅 **Weekly Team Report:**\n${reportText || "No data for this week."}`, ephemeral: true });
        }
    } catch (err) {
        console.error('Interaction Error:', err);
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: "⚠️ Error processing command.", ephemeral: true });
        } else {
            await interaction.reply({ content: "⚠️ Error processing command.", ephemeral: true });
        }
    }
});

// 7. Crash Protection & Final Startup
process.on('uncaughtException', (err) => {
    console.error('❌ CRITICAL ERROR:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ UNHANDLED REJECTION at:', promise, 'reason:', reason);
});

client.login(process.env.DISCORD_TOKEN);