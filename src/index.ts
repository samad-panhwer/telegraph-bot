// 1. Updated Imports (Removed ChatInputCommandInteraction as it wasn't used)
import { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder, TextChannel } from 'discord.js';
import { PrismaClient } from '@prisma/client';
import cron from 'node-cron';
import { config } from 'dotenv';
import http from 'http';

// 2. Load Environment Variables
config();

// 3. Updated Server (Added underscore _req to fix the build error)
http.createServer((_req, res) => {
  res.writeHead(200);
  res.end('Telegraph Bot is Running!');
}).listen(process.env.PORT || 8080);

const prisma = new PrismaClient();
const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers // Needed to check roles
  ] 
});

// 3. Define Commands
const commands = [
    new SlashCommandBuilder()
        .setName('in')
        .setDescription('Clock in for work')
        .addStringOption(opt => opt.setName('task').setDescription('What are you working on?').setRequired(true)),
    new SlashCommandBuilder().setName('out').setDescription('Clock out from work'),
].map(command => command.toJSON());

// 4. Bot Ready Logic
client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user?.tag}`);
    
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);
        await rest.put(
            Routes.applicationGuildCommands(process.env.CLIENT_ID!, process.env.GUILD_ID!), 
            { body: commands }
        );
        console.log('✅ Slash Commands Registered');
    } catch (err) {
        console.error('❌ Failed to register commands:', err);
    }
    
    // Daily Summary Job (11:59 PM PKT)
    cron.schedule('59 23 * * *', async () => {
        try {
            const channel = client.channels.cache.get(process.env.SUMMARY_CHANNEL_ID!) as TextChannel;
            if (!channel) return;

            const sessions = await prisma.session.findMany({
                where: { 
                    startTime: { gte: new Date(new Date().setHours(0,0,0,0)) },
                    isActive: false 
                },
                include: { user: true }
            });

            const embed = new EmbedBuilder()
                .setTitle("📊 DAILY DEV SUMMARY")
                .setColor("#5865F2")
                .setTimestamp();

            const description = sessions.map(s => 
                `**${s.user.username}**: ${s.task} \n⏱️ ${Math.floor((s.durationMins || 0) / 60)}h ${(s.durationMins || 0) % 60}m`
            ).join('\n\n');

            embed.setDescription(description || "No work sessions completed today.");
            await channel.send({ embeds: [embed] });
        } catch (err) {
            console.error('❌ Cron Job Error:', err);
        }
    }, { timezone: "Asia/Karachi" });
});

// 5. Interaction Handling
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // A. Check Channel
    if (interaction.channelId !== process.env.DEV_CHANNEL_ID) {
        return interaction.reply({ content: "❌ Please use the designated dev channel for this command.", ephemeral: true });
    }

    // B. Check Developer Role
    const member = interaction.guild?.members.cache.get(interaction.user.id);
    const hasRole = member?.roles.cache.has(process.env.DEVELOPER_ROLE_ID!);
    if (!hasRole) {
        return interaction.reply({ content: "❌ Only users with the Developer role can use this.", ephemeral: true });
    }

    const { commandName, user } = interaction;

    try {
        if (commandName === 'in') {
            const task = interaction.options.getString('task')!;

            // Prevent double clock-in
            const activeSession = await prisma.session.findFirst({
                where: { user: { discordId: user.id }, isActive: true }
            });
            if (activeSession) {
                return interaction.reply({ content: "❌ You are already clocked in! Use `/out` first.", ephemeral: true });
            }

            const dbUser = await prisma.user.upsert({
                where: { discordId: user.id },
                update: { username: user.username },
                create: { discordId: user.id, username: user.username }
            });

            await prisma.session.create({ data: { userId: dbUser.id, task } });
            await interaction.reply(`🚀 **${user.username}** is now working on: *${task}*`);
        }

        if (commandName === 'out') {
            const session = await prisma.session.findFirst({
                where: { user: { discordId: user.id }, isActive: true }
            });

            if (!session) {
                return interaction.reply({ content: "❌ You aren't clocked in!", ephemeral: true });
            }

            const duration = Math.round((new Date().getTime() - session.startTime.getTime()) / 60000);
            await prisma.session.update({
                where: { id: session.id },
                data: { isActive: false, endTime: new Date(), durationMins: duration }
            });

            const hours = Math.floor(duration / 60);
            const mins = duration % 60;
            await interaction.reply(`✅ **${user.username}** clocked out. \n**Duration:** ${hours}h ${mins}m`);
        }
    } catch (error) {
        console.error(error);
        await interaction.reply({ content: "⚠️ An error occurred while processing your request.", ephemeral: true });
    }
});

client.login(process.env.DISCORD_TOKEN);