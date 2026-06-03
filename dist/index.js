"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const client_1 = require("@prisma/client");
const node_cron_1 = __importDefault(require("node-cron"));
const dotenv_1 = require("dotenv");
const http_1 = __importDefault(require("http"));
(0, dotenv_1.config)();
const PORT = process.env.PORT || 8080;
http_1.default.createServer((_req, res) => {
    res.writeHead(200);
    res.end('Telegraph Bot is Running!');
}).listen(Number(PORT), '0.0.0.0', () => {
    console.log(`🌍 Health check server listening on port ${PORT}`);
});
const prisma = new client_1.PrismaClient();
const client = new discord_js_1.Client({
    intents: [
        discord_js_1.GatewayIntentBits.Guilds,
        discord_js_1.GatewayIntentBits.GuildMessages,
        discord_js_1.GatewayIntentBits.GuildMembers
    ]
});
const commands = [
    new discord_js_1.SlashCommandBuilder()
        .setName('in')
        .setDescription('Clock in for work')
        .addStringOption(opt => opt.setName('task').setDescription('What are you working on?').setRequired(true)),
    new discord_js_1.SlashCommandBuilder().setName('out').setDescription('Clock out from work'),
    new discord_js_1.SlashCommandBuilder().setName('status').setDescription('Check your current work status'),
    new discord_js_1.SlashCommandBuilder()
        .setName('inspect')
        .setDescription('Admin: Check a developer\'s time and tasks')
        .addUserOption(opt => opt.setName('user').setDescription('The user to check').setRequired(true)),
    new discord_js_1.SlashCommandBuilder().setName('weekly')
        .setDescription('Admin: Get total hours for all devs in the last 7 days'),
].map(command => command.toJSON());
client.once('ready', async () => {
    console.log(`✅ Telegraph Bot Online: ${client.user?.tag}`);
    try {
        const rest = new discord_js_1.REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(discord_js_1.Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
    }
    catch (err) {
        console.error('Command Registration Error:', err);
    }
    node_cron_1.default.schedule('59 23 * * *', async () => {
        try {
            const channel = client.channels.cache.get(process.env.SUMMARY_CHANNEL_ID);
            if (!channel)
                return;
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const sessions = await prisma.session.findMany({
                where: { startTime: { gte: today }, isActive: false },
                include: { user: true }
            });
            const embed = new discord_js_1.EmbedBuilder()
                .setTitle("📊 DAILY DEV SUMMARY")
                .setColor("#00FF00")
                .setTimestamp();
            const report = sessions.map(s => `**${s.user.username}**: ${s.task} (${Math.floor((s.durationMins || 0) / 60)}h ${(s.durationMins || 0) % 60}m)`).join('\n');
            embed.setDescription(report || "No activity logged today.");
            await channel.send({ embeds: [embed] });
        }
        catch (e) {
            console.error(e);
        }
    }, { timezone: "Asia/Karachi" });
});
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand())
        return;
    const { commandName, user, guild } = interaction;
    const member = guild?.members.cache.get(user.id);
    const isDev = member?.roles.cache.has(process.env.DEVELOPER_ROLE_ID);
    const isAdmin = member?.roles.cache.has(process.env.ADMIN_ROLE_ID);
    if (interaction.channelId !== process.env.DEV_CHANNEL_ID && !isAdmin) {
        return interaction.reply({ content: "❌ Use the designated dev channel.", ephemeral: true });
    }
    try {
        if (commandName === 'in') {
            if (!isDev)
                return interaction.reply({ content: "Only Developers can clock in.", ephemeral: true });
            const task = interaction.options.getString('task');
            const active = await prisma.session.findFirst({ where: { user: { discordId: user.id }, isActive: true } });
            if (active)
                return interaction.reply({ content: "You are already clocked in!", ephemeral: true });
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
            if (!session)
                return interaction.reply({ content: "You are not clocked in.", ephemeral: true });
            const duration = Math.round((new Date().getTime() - session.startTime.getTime()) / 60000);
            await prisma.session.update({ where: { id: session.id }, data: { isActive: false, endTime: new Date(), durationMins: duration } });
            await interaction.reply(`✅ **${user.username}** clocked out. Time: ${Math.floor(duration / 60)}h ${duration % 60}m`);
        }
        if (commandName === 'status') {
            const active = await prisma.session.findFirst({ where: { user: { discordId: user.id }, isActive: true } });
            if (!active)
                return interaction.reply({ content: "You are currently: **Offline**", ephemeral: true });
            const elapsed = Math.round((new Date().getTime() - active.startTime.getTime()) / 60000);
            await interaction.reply({ content: `⏳ You are clocked in for: **${active.task}** (${elapsed}m elapsed)`, ephemeral: true });
        }
        if (commandName === 'inspect') {
            if (!isAdmin)
                return interaction.reply({ content: "Admin only command.", ephemeral: true });
            const target = interaction.options.getUser('user');
            const sessions = await prisma.session.findMany({
                where: { user: { discordId: target.id } },
                orderBy: { startTime: 'desc' },
                take: 5
            });
            const totalMins = sessions.reduce((acc, s) => acc + (s.durationMins || 0), 0);
            const embed = new discord_js_1.EmbedBuilder()
                .setTitle(`Activity: ${target.username}`)
                .addFields({ name: 'Total (Last 5 sessions)', value: `${Math.floor(totalMins / 60)}h ${totalMins % 60}m` }, { name: 'Recent Tasks', value: sessions.map(s => `• ${s.task} (${s.durationMins || 0}m)`).join('\n') || 'None' });
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
        if (commandName === 'weekly') {
            if (!isAdmin)
                return interaction.reply({ content: "Admin only command.", ephemeral: true });
            const lastWeek = new Date();
            lastWeek.setDate(lastWeek.getDate() - 7);
            const sessions = await prisma.session.findMany({
                where: { startTime: { gte: lastWeek }, isActive: false },
                include: { user: true }
            });
            const userTotals = {};
            sessions.forEach(s => {
                userTotals[s.user.username] = (userTotals[s.user.username] || 0) + (s.durationMins || 0);
            });
            const report = Object.entries(userTotals)
                .map(([name, mins]) => `**${name}**: ${Math.floor(mins / 60)}h ${mins % 60}m`)
                .join('\n');
            await interaction.reply({ content: `📅 **Weekly Team Report (Last 7 Days):**\n${report || "No data available."}`, ephemeral: true });
        }
    }
    catch (e) {
        console.error(e);
        await interaction.reply({ content: "Error processing command.", ephemeral: true });
    }
});
client.login(process.env.DISCORD_TOKEN);
//# sourceMappingURL=index.js.map